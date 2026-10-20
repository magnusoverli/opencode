const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { patchWorkspaceRecovery } = require('../rootfs/opt/openchamber/patch-workspace-recovery.cjs');
const helper = import(pathToFileURL(path.join(__dirname, '../rootfs/opt/openchamber/workspace-recovery/workspaceRecovery.ts')).href);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-workspace-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'packages/ui/src/main.tsx');
  const mobile = path.join(root, 'packages/ui/src/apps/renderMobileApp.tsx');
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.mkdirSync(path.dirname(mobile), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/ui/src/components/auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/ui/src/lib'), { recursive: true });
  fs.writeFileSync(desktop, 'import App from "./App";\n            <App apis={runtimeAPIs} />\n');
  fs.writeFileSync(mobile, 'import { MobileApp } from "./MobileApp";\n  const app = <MobileApp apis={resolvedApis} />;\n');
  return { root, desktop, mobile };
}

test('installs the recovery gate on desktop and mobile browser, not native connect flows', t => {
  const { root, desktop, mobile } = fixture(t);
  patchWorkspaceRecovery(root);
  assert.match(fs.readFileSync(desktop, 'utf8'), /<WorkspaceRecoveryGate><App/);
  assert.match(fs.readFileSync(mobile, 'utf8'), /isNativeShell \? <MobileApp.*: <WorkspaceRecoveryGate>/);
  assert.throws(() => patchWorkspaceRecovery(root), /Unexpected workspace recovery source/);
});

test('source drift fails before writing any files', t => {
  const { root, desktop, mobile } = fixture(t);
  const original = fs.readFileSync(desktop, 'utf8');
  fs.writeFileSync(mobile, 'changed upstream');
  assert.throws(() => patchWorkspaceRecovery(root), /Unexpected workspace recovery source/);
  assert.equal(fs.readFileSync(desktop, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, 'packages/ui/src/lib/workspaceRecovery.ts')), false);
});

for (const [status, body, expected] of [
  [200, { isDirectory: true }, 'available'],
  [404, { reason: 'not-found' }, 'missing'],
  [400, { reason: 'not-directory' }, 'missing'],
  [404, { error: 'Route not found' }, 'unknown'],
  [401, { reason: 'not-found' }, 'unknown'],
  [403, { reason: 'permission-denied' }, 'unknown'],
  [502, { reason: 'not-found' }, 'unknown'],
  [200, { isDirectory: false }, 'unknown'],
]) {
  test(`directory probe ${status} ${JSON.stringify(body)} => ${expected}`, async () => {
    const { probeWorkspace } = await helper;
    assert.equal(await probeWorkspace('/missing', async (endpoint, query, signal) => {
      assert.equal(endpoint, '/api/fs/directory-stat');
      assert.deepEqual(query, { path: '/missing' });
      assert.ok(signal instanceof AbortSignal);
      return Response.json(body, { status });
    }), expected);
  });
}

test('transport errors and malformed responses preserve selection', async () => {
  const { probeWorkspace } = await helper;
  assert.equal(await probeWorkspace('/offline', async () => { throw new Error('offline'); }), 'unknown');
  assert.equal(await probeWorkspace('/offline', async () => new Response('<html>')), 'unknown');
  assert.equal(await probeWorkspace('', async () => { throw new Error('must not fetch'); }), 'unknown');
});

test('recovery requires both an existing directory and successful OpenCode location resolution', async () => {
  const { verifyRecoveryWorkspace } = await helper;
  const calls = [];
  assert.equal(await verifyRecoveryWorkspace('/homeassistant', async (endpoint, query) => {
    calls.push([endpoint, query]);
    return Response.json(endpoint === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  }), true);
  assert.deepEqual(calls, [
    ['/api/fs/directory-stat', { path: '/homeassistant' }],
    ['/api/location', { 'location[directory]': '/homeassistant' }],
  ]);
  assert.equal(await verifyRecoveryWorkspace('/bad', async endpoint => Response.json(
    endpoint === '/api/location' ? { error: 'LocationNotFoundError' } : { isDirectory: true },
    { status: endpoint === '/api/location' ? 404 : 200 },
  )), false);
  let reads = 0;
  assert.equal(await verifyRecoveryWorkspace('/missing', async () => {
    reads++;
    return Response.json({ reason: 'not-found' }, { status: 404 });
  }), false);
  assert.equal(reads, 1);
  assert.equal(await verifyRecoveryWorkspace('/requested', async endpoint => Response.json(
    endpoint === '/api/location' ? { directory: '/server-default' } : { isDirectory: true },
  )), false, 'A response for a different directory is not recovery validation');
});
