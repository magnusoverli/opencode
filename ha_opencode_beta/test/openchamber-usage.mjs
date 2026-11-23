// Run against the actual pinned source and its authenticated API credential reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const source = process.env.OPENCHAMBER_TEST_SOURCE || '/opt/openchamber-preview';

test('managed Usage follows backend login, refresh, selection and disconnect without legacy fallback', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-usage-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE'].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  const legacy = path.join(directory, '.local/share/opencode/auth.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ openai: { type: 'oauth', access: 'fixture-stale-v1' } }));
  const legacyBefore = fs.readFileSync(legacy);
  const oauth = (access) => ({ type: 'oauth', methodID: 'chatgpt-browser', access,
    refresh: 'fixture-refresh', expires: 9999999999999, metadata: { accountID: 'fixture-account' } });
  let entries = [
    { id: 'older', integrationID: 'openai', label: 'old', active: false, value: oauth('fixture-inactive') },
    { id: 'selected', integrationID: 'openai', label: 'current', active: true, value: oauth('fixture-current') },
  ];
  let unavailable = false;
  let reads = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET', 'Usage must never change provider credentials');
    assert.equal(req.url, '/api/credential');
    assert.equal(req.headers.authorization, 'Basic fixture-backend');
    reads++;
    res.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(unavailable ? {} : { data: entries }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await import(pathToFileURL(path.join(source, 'packages/web/build/server/lib/opencode/auth.js')));
  const quota = await import(pathToFileURL(path.join(source, 'packages/web/build/server/lib/quota/providers/codex.js')));
  auth.configureOpenCodeCredentials(auth.openCodeCredentialSource({
    buildOpenCodeUrl: (url) => base + url,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic fixture-backend' }),
  }));
  t.after(async () => {
    auth.configureOpenCodeCredentials(null);
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let expected = 'fixture-current';
  let calls = 0;
  let denied = false;
  globalThis.fetch = async (url, options) => {
    if (String(url instanceof Request ? url.url : url).startsWith(base)) return originalFetch(url, options);
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.Authorization, `Bearer ${expected}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], 'fixture-account');
    return denied ? new Response('', { status: 401 }) : new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 123456 } },
    }));
  };
  assert.equal((await quota.fetchQuota()).ok, true);
  expected = 'fixture-refreshed';
  entries[1].value = oauth(expected);
  assert.equal((await quota.fetchQuota()).ok, true, 'Read refreshed credentials on each request');
  expected = 'fixture-inactive';
  entries[0].active = true;
  entries[1].active = false;
  assert.equal((await quota.fetchQuota()).ok, true, 'Follow backend account selection');
  entries = [];
  assert.equal((await quota.fetchQuota()).configured, false, 'Disconnect must not resurrect V1 sign-in');
  assert.equal(calls, 3);
  unavailable = true;
  await assert.rejects(auth.readOpenCodeCredentials(), 'An unreachable backend must not look disconnected');
  unavailable = false;
  entries = [{ id: 'selected', integrationID: 'openai', label: 'current', active: true, value: oauth(expected) }];
  denied = true;
  const result = await quota.fetchQuota();
  assert.equal(result.ok, false);
  assert.match(result.error, /usage authorization expired/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-inactive|fixture-refresh|fixture-stale-v1/);
  assert.ok(reads >= 6);
  assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
  auth.configureOpenCodeCredentials(null);
  await assert.rejects(auth.readOpenCodeCredentials(), /not connected yet/);
});
