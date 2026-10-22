import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerManagedAgentRoutes } from '../rootfs/opt/openchamber/agent-settings/routes.mjs';
import { AgentSettingsError } from '../rootfs/opt/opencode-v2-homeassistant/agents-policy.js';

const require = createRequire(process.env.HA_EDITOR_TEST_DEPS ? resolve(process.env.HA_EDITOR_TEST_DEPS, 'package.json') : new URL('../rootfs/opt/ha-mcp-server/package.json', import.meta.url));
const express = require('express');
const { patchAgentSettings } = createRequire(import.meta.url)('../rootfs/opt/openchamber/patch-agent-settings.cjs');
const relative = 'packages/web/server/lib/opencode/bootstrap-runtime.js';
const source = `export const createBootstrapRuntime = () => {
    registerAuthAndAccessRoutes(app, {
      normalizeTunnelSessionTtlMs,
    });

    notificationEmitRoutes.registerApiRoute();

    registerTtsRoutes(app, { sayTTSCapability });
};`;

test('source patch fails closed on missing/duplicate/reordered auth anchors and missing support', async t => {
  for (const [index, input] of [source, source.replace('normalizeTunnelSessionTtlMs', 'changed'), source + source, source.replace('registerAuthAndAccessRoutes', 'changed')].entries()) {
    const root = await mkdtemp(join(tmpdir(), 'ha-agent-patch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, input);
    if (index === 0) {
      assert.throws(() => patchAgentSettings(root, join(root, 'missing')));
      assert.equal(await readFile(target, 'utf8'), input);
      patchAgentSettings(root);
      const updated = await readFile(target, 'utf8');
      assert.ok(updated.indexOf('    registerAuthAndAccessRoutes') < updated.indexOf('    registerManagedAgentRoutes'));
      assert.ok(updated.indexOf('    registerManagedAgentRoutes') < updated.indexOf('    registerTtsRoutes'));
      await access(join(dirname(target), 'ha-agent-settings-routes.mjs'));
      assert.throws(() => patchAgentSettings(root));
    } else {
      assert.throws(() => patchAgentSettings(root));
      assert.equal(await readFile(target, 'utf8'), input);
    }
  }
});

async function fixture(t) {
  const app = express(), calls = [];
  let authorized = true, enabled = true;
  app.use('/api', (_req, res, next) => authorized ? next() : res.status(401).end());
  registerManagedAgentRoutes(app, { express, bridge: () => enabled ? { handle: async (...input) => {
    calls.push(input);
    if (input[1] === 'protected') throw new AgentSettingsError('Managed agent cannot be changed', 403);
    if (input[1] === 'unexpected') throw new Error('private-credential-must-not-leak');
    return { success: true, applied: true };
  } } : null });
  app.use(express.json({ limit: '1mb' }));
  app.all('/api/config/agents/:name', (_req, res) => res.status(599).end('Upstream filesystem route must not execute'));
  app.post('/api/unrelated', (_req, res) => res.json({ success: true }));
  const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { calls, deny: () => { authorized = false; }, disable: () => { enabled = false; },
    request: (method, path, body) => fetch(origin + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
  };
}

test('authenticated routes precede every upstream agent filesystem operation and preserve error/response shapes', async t => {
  const f = await fixture(t);
  for (const [method, path, operation] of [
    ['GET', '/api/config/disabled-agents', 'disabled'], ['GET', '/api/config/agents/team%2Freviewer', 'metadata'],
    ['GET', '/api/config/agents/build/config', 'config'], ['GET', '/api/config/agents/build/permissions', 'permissions'],
    ['POST', '/api/config/agents/helper', 'create'], ['PATCH', '/api/config/agents/build', 'update'], ['DELETE', '/api/config/agents/helper', 'delete'],
  ]) {
    const response = await f.request(method, path + '?directory=%2Fhomeassistant');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).applied, true);
    assert.equal(f.calls.at(-1)[0], operation);
    assert.equal(f.calls.at(-1)[3], '/homeassistant');
  }
  assert.equal(f.calls[1][1], 'team/reviewer');
  assert.equal((await f.request('DELETE', '/api/config/agents/helper?scope=project')).status, 200);
  assert.equal(f.calls.at(-1)[2].scope, 'project', 'delete query scope reaches guarded controller');
  assert.equal((await f.request('PATCH', '/api/config/agents/protected', {})).status, 403);
  const secret = await f.request('PATCH', '/api/config/agents/unexpected', {});
  assert.equal(secret.status, 503); assert.ok(!(await secret.text()).includes('private-credential'));
  assert.equal((await f.request('POST', '/api/config/agents/helper?scope=project', { scope: 'user' })).status, 400);
  f.disable(); assert.equal((await f.request('POST', '/api/config/agents/helper', {})).status, 503);
  const before = f.calls.length;
  f.deny(); assert.equal((await f.request('PATCH', '/api/config/agents/build', {})).status, 401);
  assert.equal(f.calls.length, before);
});

test('agent body limits do not break unrelated UI requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/config/agents/helper', '{broken')).status, 400);
  assert.equal((await f.request('POST', '/api/config/agents/helper', { system: 'x'.repeat(100000) })).status, 413);
  assert.equal((await f.request('POST', '/api/unrelated', { content: 'x'.repeat(100000) })).status, 200);
  assert.equal(f.calls.length, 0);
});
