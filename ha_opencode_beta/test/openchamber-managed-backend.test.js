const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const script = path.join(__dirname, "../rootfs/opt/openchamber/patch-managed-backend.cjs");
// Independent upstream anchors; the real runtime is exercised in the image too.
const sources = {
  "server/lib/opencode/hmr-state-runtime.js": `const initialPassword = [processLike.env.OPENCODE_PASSWORD, processLike.env.OPENCODE_SERVER_PASSWORD]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0) || '';`,
  "server/lib/opencode/auth-state-runtime.js": "assignInjectedEnv(process.env, { OPENCODE_SERVER_PASSWORD: normalized });",
  "server/lib/opencode/lifecycle.js": "const startOpenCode = async () => {\n};",
  "server/lib/opencode/proxy.js": "if (!hasParsedBodyValue(req.body) && originalContentLength <= 0) return null;\nproxyReq.removeHeader('transfer-encoding');\nproxyReq.setHeader('content-length', String(body.length));",
  "server/index.js": "const REMOTE_CLIENTS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'remote-clients.json');\nconst CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'client-pairing-sessions.json');",
  "server/lib/ui-auth/ui-auth.js": "const JWT_SECRET_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jwt-secret');",
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-managed-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}
const run = (root) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });
const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

test("patches the injected-env setter without duplicating upstream proxy framing", (t) => {
  const root = fixture(t);
  assert.equal(run(root).status, 0);
  assert.doesNotMatch(read(root, "server/lib/opencode/auth-state-runtime.js"), /assignInjectedEnv/);
  assert.match(read(root, "server/lib/opencode/hmr-state-runtime.js"), /ha\.openchamber\.credential/);
  assert.match(read(root, "server/lib/opencode/lifecycle.js"), /throw new Error\('OpenCode is managed by Home Assistant/);
  const proxy = read(root, "server/lib/opencode/proxy.js");
  assert.match(proxy, /!req\.headers\?\.\['transfer-encoding'\]/);
  assert.equal(proxy.split("proxyReq.removeHeader('transfer-encoding');").length, 2);
  for (const file of ["server/index.js", "server/lib/ui-auth/ui-auth.js"]) {
    assert.match(read(root, file), /process\.env\.OPENCHAMBER_AUTH_DIR \|\| OPENCHAMBER_DATA_DIR/);
  }
});

test("late source drift rejects every write, including credentials and lifecycle", (t) => {
  const root = fixture(t);
  const file = "server/lib/ui-auth/ui-auth.js";
  fs.writeFileSync(path.join(root, file), "changed upstream");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected preview source/);
  for (const [name, source] of Object.entries(sources)) {
    assert.equal(read(root, name), name === file ? "changed upstream" : source);
  }
});

test("a repeated patch fails without modifying the already patched source", (t) => {
  const root = fixture(t);
  assert.equal(run(root).status, 0);
  const patched = Object.fromEntries(Object.keys(sources).map((file) => [file, read(root, file)]));
  assert.equal(run(root).status, 1);
  for (const [file, source] of Object.entries(patched)) assert.equal(read(root, file), source);
});
