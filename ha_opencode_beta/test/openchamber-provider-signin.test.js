const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const script = path.join(__dirname, "../rootfs/opt/openchamber/patch-provider-signin.cjs");
const { patchProviderSignin } = require(script);

function fixture(t, newline = "\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-signin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Independent anchor from pinned OpenChamber 2.5.0. The original component's
  // method labels, SDK calls, polling and cancellation must remain untouched.
  const original = `// upstream authentication stays unchanged
  return (
    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {
        const isActive = activeMethodID === method.id;
`;
  fs.writeFileSync(target, original.replaceAll("\n", newline));
  return { root, target, original };
}

for (const newline of ["\n", "\r\n"]) {
  test(`adds OpenAI-only remote sign-in guidance without replacing either method (${JSON.stringify(newline)})`, t => {
    const { root, target, original } = fixture(t, newline);
    patchProviderSignin(root);
    const result = fs.readFileSync(target, "utf8");
    assert.match(result, /integrationId === 'openai'/);
    assert.match(result, /Codex device code \(legacy\)/);
    assert.match(result, /not the newer <strong>Sign in with ChatGPT/);
    assert.match(result, /detects approval automatically/);
    assert.match(result, /no restart or Terminal switch/);
    assert.match(result, /OpenCode handles credential storage and refresh/);
    assert.equal(result.replace(/      \{integrationId === 'openai'[\s\S]*?      \)\}\n/, ""), original);
    assert.throws(() => patchProviderSignin(root), /Unexpected preview provider sign-in source/);
    assert.equal(fs.readFileSync(target, "utf8"), result);
  });
}

test("fails closed without writes on missing or duplicated pinned-source anchors", t => {
  for (const content of ["changed upstream", fixture(t).original.repeat(2)]) {
    const { root, target } = fixture(t);
    fs.writeFileSync(target, content);
    assert.throws(() => patchProviderSignin(root), /Unexpected preview provider sign-in source/);
    assert.equal(fs.readFileSync(target, "utf8"), content);
  }
});

test("requires an explicit upstream checkout", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: patch-provider-signin.cjs/);
});

test("beta builds and exercises the patched provider UI before shipping it", () => {
  const docker = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
  assert.match(docker, /ARG OPENCHAMBER_REVISION=ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd/);
  const patch = docker.indexOf("RUN node /tmp/patch-provider-signin.cjs /opt/openchamber-preview");
  assert.ok(patch > docker.indexOf("git checkout --detach FETCH_HEAD"));
  assert.ok(patch < docker.indexOf("bun run --cwd packages/ui type-check"));
  assert.match(docker, /bun test src\/components\/sections\/providers\/ha-provider-signin\.test\.tsx/);
});
