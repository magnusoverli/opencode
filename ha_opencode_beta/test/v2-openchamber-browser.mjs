// In-image integration acceptance: actual pinned UI/backend and shipped Ingress
// proxy, with a local model fixture and simulated Supervisor forwarding only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { OpenCode } from '/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js';

const require = createRequire('/opt/ha-mcp-server/package.json');
const puppeteer = require('puppeteer-core');
const runtime = '/run/opencode-v2';
const generation = '/data/v2/generations/' + randomUUID().replaceAll('-', '');
const base = '/api/hassio_ingress/fixture-browser';
const password = 'a'.repeat(64);
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const children = [];
let browser;
let logs = '';
let modelCalls = 0;
let runtimeCreated = false;
const workspaceProbes = [];
const start = (bin, args, env) => {
  const child = spawn(bin, args, { env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; });
  return child;
};
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
};
const wait = async (check, label) => {
  for (let i = 0; i < 150; i++) {
    try { if (await check()) return; } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
};
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  assert.equal(body.model, 'fixture-model');
  modelCalls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'HA_PINNED_UI_OK' }, null], [{}, 'stop']]) {
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
const ingress = createServer((req, res) => {
  if (!req.url.startsWith(base + '/')) return res.writeHead(404).end();
  const upstream = request({ host: '127.0.0.1', port: 8099, path: req.url.slice(base.length), method: req.method,
    headers: { ...req.headers, 'x-ingress-path': base, 'x-remote-user-id': 'c'.repeat(32) } }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
const root = await mkdtemp('/tmp/ha-pinned-ui-');
try {
  // Refuse to run over an active app. This fixture belongs in a disposable image.
  await mkdir(runtime);
  runtimeCreated = true;
  for (const name of ['home', 'config', 'cache', 'workspace']) await mkdir(`${runtime}/${name}`);
  for (const name of ['data', 'state']) await mkdir(`${generation}/${name}`, { recursive: true });
  await writeFile(`${runtime}/server-password`, password, { mode: 0o600 });
  await writeFile(`${runtime}/ready`, generation, { mode: 0o600 });
  await writeFile(`${runtime}/lan.json`, JSON.stringify({ apiEnabled: false, uiEnabled: false }), { mode: 0o600 });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await writeFile(`${runtime}/managed.json`, JSON.stringify({
    model: 'fixture/coding', autoupdate: false, share: 'disabled', snapshots: false,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    providers: { fixture: { name: 'Fixture', package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
      models: { coding: { modelID: 'fixture-model', name: 'Fixture model', limit: { context: 32000, output: 1000 } } } } },
  }));
  const startBackend = () => start('/usr/local/libexec/opencode-v2', ['serve', '--hostname', '127.0.0.1', '--port', '4100'], {
    HOME: `${runtime}/home`, XDG_CONFIG_HOME: `${runtime}/config`, XDG_DATA_HOME: `${generation}/data`,
    XDG_STATE_HOME: `${generation}/state`, XDG_CACHE_HOME: `${runtime}/cache`,
    OPENCODE_CONFIG: `${runtime}/managed.json`, OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: 'true',
  });
  let backend = startBackend();
  const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:4100', headers });
  await wait(async () => (await client.server.info()).version === '2.0.26', 'backend startup');
  const credentials = await client.credential.create({ integrationID: 'fixture', value: { type: 'key', key: 'fixture-persisted-key' } });
  await mkdir(`${root}/ui`);
  // Exercise the existing-installation settings migration as well as a new chat.
  await writeFile(`${root}/ui/settings.json`, JSON.stringify({ lastDirectory: `${runtime}/workspace`, defaultModel: 'fixture/coding' }));
  const startUi = () => start('node', ['/opt/openchamber/managed-server.mjs'], {
    HOME: root, OPENCHAMBER_DATA_DIR: `${root}/ui`, OPENCHAMBER_RELAY_HOST: 'off',
    OPENCHAMBER_SKIP_API_COMPRESSION: 'true', OPENCHAMBER_COMPRESS_API: 'false',
    OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR: '/usr/local/bin',
    OPENCHAMBER_UPDATE_API_URL: 'http://127.0.0.1:8099/__ha_openchamber_update_check',
    OPENCHAMBER_OPENCODE_CWD: `${runtime}/workspace`,
    OPENCODE_HOST: 'http://127.0.0.1:4100', OPENCODE_SKIP_START: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    LD_PRELOAD: '/usr/local/lib/opencode-v2-non-dumpable.so',
  });
  let ui = startUi();
  await wait(async () => (await fetch('http://127.0.0.1:3010/health')).ok, 'UI startup');
  start('node', ['/usr/local/bin/openchamber-ingress-proxy.js'], {
    HA_INGRESS_UI: 'openchamber', HA_INGRESS_PROXY_IP: '127.0.0.1',
    OPENCHAMBER_ALLOW_ANY_REMOTE: 'false', OPENCHAMBER_INGRESS_HOST: '127.0.0.1',
  });
  await new Promise(resolve => ingress.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${ingress.address().port}${base}/`;
  await wait(async () => (await fetch(url)).ok, 'Ingress startup');
  browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [], escaped = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/api/session') {
      const model = JSON.parse(req.postData() || '{}').model;
      if (model?.providerID !== 'fixture' || model?.id !== 'coding') {
        errors.push('UI selected a non-fixture model');
        void req.abort();
        return;
      }
    }
    void req.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const candidate = new URL(response.url());
    if (candidate.pathname.endsWith('/api/fs/directory-stat')) {
      workspaceProbes.push({ path: candidate.searchParams.get('path'), status: response.status(),
        result: await response.json().catch(() => null) });
    }
  });
  page.on('request', req => {
    const candidate = new URL(req.url());
    if (candidate.origin === new URL(url).origin && /^\/(api|assets)\//.test(candidate.pathname)
      && !candidate.pathname.startsWith(base + '/')) escaped.push(candidate.pathname);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 45000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Choose project')?.click());
  await page.waitForSelector('[role="dialog"][aria-label="Project"] [role="option"]');
  await page.evaluate(() => {
    const option = [...document.querySelectorAll('[role="dialog"][aria-label="Project"] [role="option"]')].find(option => option.textContent.trim() === 'workspace');
    if (!option) throw new Error('Fixture project missing');
    option.click();
  });
  const editor = await page.waitForSelector('[data-testid="chat-input"] [contenteditable="true"]', { visible: true, timeout: 45000 });
  console.log('CHECK: UI composer loaded');
  await editor.click();
  await page.keyboard.type('Reply with the fixture confirmation.');
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"]')?.disabled);
  const created = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === base + '/api/session');
  await page.click('button[aria-label="Send message"]');
  const response = await created;
  assert.equal(response.status(), 200);
  const id = (await response.json()).data.id;
  await page.waitForFunction(() => document.body.textContent.includes('HA_PINNED_UI_OK'), { timeout: 45000 });
  assert.ok(modelCalls > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(escaped, []);
  const auth = await import('/opt/openchamber-preview/packages/web/server/lib/opencode/auth.js');
  auth.configureOpenCodeCredentials(auth.openCodeCredentialSource({ buildOpenCodeUrl: p => `http://127.0.0.1:4100${p}`, getOpenCodeAuthHeaders: () => headers }));
  assert.equal((await auth.readOpenCodeCredentials()).fixture.key, 'fixture-persisted-key');
  await stop(ui);
  assert.equal((await client.session.get({ sessionID: id })).id, id, 'Stopping UI must leave backend/history running');
  await stop(backend);
  backend = startBackend();
  await wait(async () => (await client.server.info()).version === '2.0.26', 'backend restart');
  ui = startUi();
  await wait(async () => (await fetch('http://127.0.0.1:3010/health')).ok, 'UI restart');
  assert.equal((await client.session.get({ sessionID: id })).id, id);
  assert.equal((await auth.readOpenCodeCredentials()).fixture.key, 'fixture-persisted-key');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.textContent.includes('HA_PINNED_UI_OK'), { timeout: 30000 });
  const lastSession = await page.evaluate(() => localStorage.getItem('oc.lastSession.v1'));
  assert.ok(lastSession, 'Fixture must have a persisted historical session');
  const historical = await client.session.get({ sessionID: id });
  assert.equal(historical.location.directory, `${runtime}/workspace`);
  const recoveryDirectory = `${root}/recovery`;
  await mkdir(recoveryDirectory);
  // Delete ONLY this fixture's workspace, not state/history. The running backend
  // is restarted so a cached Location cannot disguise the real missing path.
  await rm(`${runtime}/workspace`, { recursive: true });
  await stop(backend);
  backend = startBackend();
  await wait(async () => (await client.server.info()).version === '2.0.26', 'missing-workspace backend restart');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="workspace-recovery"]', { timeout: 30000 });
  assert.equal(new URL(page.url()).searchParams.get('session'), id, 'Fixture exercises the stale historical URL too');
  await page.$eval('#recovery-directory', input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '/definitely-missing-ha-fixture');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('[data-testid="workspace-recovery"] form').requestSubmit());
  await page.waitForSelector('[data-testid="workspace-recovery"] [role="alert"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('oc.lastSession.v1')), lastSession, 'Failed recovery preserves last-session pointer');
  await page.$eval('#recovery-directory', (input, directory) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, directory);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, recoveryDirectory);
  await page.evaluate(() => document.querySelector('[data-testid="workspace-recovery"] form').requestSubmit());
  await page.waitForSelector('[data-testid="chat-input"] [contenteditable="true"]', { visible: true, timeout: 30000 });
  await page.waitForFunction(() => document.body.textContent.includes('Fixture model'), { timeout: 30000 });
  await wait(async () => await page.evaluate(directory => localStorage.getItem('lastDirectory') === directory, recoveryDirectory), 'recovered workspace persisted');
  assert.equal(new URL(page.url()).searchParams.has('session'), false, 'Recovery clears the stale URL navigation pointer');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="chat-input"] [contenteditable="true"]', { visible: true, timeout: 30000 });
  assert.equal(await page.$('[data-testid="workspace-recovery"]'), null, 'Recovery survives reload');
  const afterRecovery = await client.session.get({ sessionID: id });
  assert.deepEqual(afterRecovery.location, historical.location, 'Historical session location never changes');
  assert.equal(afterRecovery.id, id);
  await assert.rejects(access(`${runtime}/workspace`), { code: 'ENOENT' });
  // Reopening the old workspace must offer recovery again, including mobile.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${url}?session=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="workspace-recovery"]', { timeout: 30000 });
  await page.$eval('#recovery-directory', (input, directory) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, directory);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, recoveryDirectory);
  await page.evaluate(() => document.querySelector('[data-testid="workspace-recovery"] form').requestSubmit());
  await page.waitForSelector('button[data-composer-morph-prompt="true"]', { visible: true, timeout: 30000 });
  await page.tap('button[data-composer-morph-prompt="true"]');
  await page.waitForSelector('[contenteditable="true"]', { visible: true, timeout: 30000 });
  assert.equal(await page.$('#ha-assist-setup'), null);
  assert.deepEqual(errors, []);
  assert.deepEqual(escaped, []);
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  await client.credential.remove({ credentialID: credentials.id });
  assert.equal((await auth.readOpenCodeCredentials()).fixture, undefined);
  await client.session.remove({ sessionID: id });
  assert.doesNotMatch(logs, /fixture-persisted-key/);
  console.log('PASS: pinned desktop/mobile Ingress, prompt/stream, credentials, restart retention, missing-workspace recovery/reload, and unchanged historical directories');
} catch (error) {
  if (browser) {
    const pages = await browser.pages();
    console.error('Browser state:', await pages.at(-1).evaluate(() => document.body.innerText));
    console.error('Workspace probes:', workspaceProbes);
  }
  console.error(logs.replaceAll(password, '[redacted]').replaceAll('fixture-persisted-key', '[redacted]'));
  throw error;
} finally {
  if (browser) await browser.close();
  ingress.closeAllConnections();
  provider.closeAllConnections();
  ingress.close();
  provider.close();
  for (const child of children.toReversed()) await stop(child);
  await rm(root, { recursive: true, force: true });
  if (runtimeCreated) {
    await rm(runtime, { recursive: true, force: true });
    await rm(generation, { recursive: true, force: true });
  }
}
