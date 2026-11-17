const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function openFrame(script, raw, session) {
  const window = { localStorage: raw, sessionStorage: session, addEventListener() {} };
  // Execute the storage installer delivered by the real launched proxy, before
  // the unrelated URL/fetch shims. Do not supply a namespace from the test.
  const boundary = script.indexOf("  const configuredBasePath =");
  assert.ok(boundary > 0, "proxy must deliver its pre-module storage installer");
  runInNewContext(script.slice(0, boundary) + "})();", { window });
  return window;
}

async function launchedBootstrap(root, channel, fallback = false) {
  const addon = resolve(__dirname, "../../", channel === "beta" ? "ha_opencode_beta" : "ha_opencode");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const mode = join(root, `${channel}-mode`);
  const marker = join(root, `${channel}-identity`);
  const channelScript = join(root, `${channel}-channel.sh`);
  await writeFile(mode, "openchamber\n");
  await writeFile(marker, `${channel}\n`);
  await writeFile(channelScript, (await readFile(join(addon, "rootfs/usr/local/lib/opencode/channel.sh"), "utf8"))
    .replaceAll("\r\n", "\n").replaceAll("/data/.addon_channel", marker));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // Preserve the actual env -i launch and channel wiring. Redirect only fixture
  // files, listen address/port and executable paths; no live /data writes.
  const command = (await readFile(join(addon, "rootfs/etc/s6-overlay/s6-rc.d/ha-openchamber-ingress/run"), "utf8"))
    .replaceAll("\r\n", "\n")
    .replaceAll("/data/.interface_mode", mode)
    .replaceAll("/usr/local/lib/opencode/channel.sh", channelScript)
    .replace('export OPENCHAMBER_INGRESS_HOST="0.0.0.0"', 'export OPENCHAMBER_INGRESS_HOST="127.0.0.1"')
    .replace("export OPENCHAMBER_INGRESS_PORT=8099", `export OPENCHAMBER_INGRESS_PORT=${port}`)
    .replace("node /usr/local/bin/openchamber-ingress-proxy.js",
      `${quote(process.execPath)} ${quote(join(addon, "rootfs/usr/local/bin/openchamber-ingress-proxy.js"))}`);
  const env = { ...process.env, ADDON_CHANNEL: channel, HA_TEST_UNRELATED: "must-not-be-inherited" };
  if (fallback) delete env.ADDON_CHANNEL;
  const child = spawn("bash", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", value => { logs += value; });
  child.stderr.on("data", value => { logs += value; });
  const exit = once(child, "exit");
  try {
    let script;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, logs);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__openchamber_ingress_runtime.js`, {
          headers: { "x-ingress-path": `/api/hassio_ingress/${channel}` },
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        script = await response.text();
        break;
      } catch { await delay(25); }
    }
    assert.ok(script, logs);
    const environment = await readFile(`/proc/${child.pid}/environ`, "utf8");
    assert.ok(!environment.includes("HA_TEST_UNRELATED="), "keep the sanitized process boundary");
    return script;
  } finally {
    child.kill("SIGTERM");
    await exit;
  }
}

test("actual stable/beta ingress launchers isolate workspace/session state on one browser origin", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-channel-launch-"));
  try {
    const stableScript = await launchedBootstrap(root, "stable");
    const betaScript = await launchedBootstrap(root, "beta");
    const raw = storage(), session = storage();
    raw.setItem("unrelated-home-assistant-key", "preserve");
    const stable = openFrame(stableScript, raw, session);
    const stablePath = "/data/.config/openchamber/chats/stable-only";
    stable.localStorage.setItem("lastDirectory", stablePath);
    stable.localStorage.setItem("oc.lastSession.v1", "stable-session");
    stable.sessionStorage.setItem("draft", "stable-draft");
    const beta = openFrame(betaScript, raw, session);
    assert.equal(stable.__HA_OPENCODE_STORAGE_SCOPE__, "ha-opencode-stable");
    assert.equal(beta.__HA_OPENCODE_STORAGE_SCOPE__, "ha-opencode-beta");
    assert.equal(beta.localStorage.getItem("lastDirectory"), null);
    assert.equal(beta.localStorage.getItem("oc.lastSession.v1"), null);
    assert.equal(beta.sessionStorage.getItem("draft"), null);
    beta.localStorage.setItem("lastDirectory", "/homeassistant");
    beta.localStorage.setItem("oc.lastSession.v1", "beta-session");
    assert.equal(openFrame(stableScript, raw, session).localStorage.getItem("lastDirectory"), stablePath);
    const reopened = openFrame(betaScript, raw, session);
    assert.equal(reopened.localStorage.getItem("lastDirectory"), "/homeassistant");
    assert.equal(reopened.localStorage.getItem("oc.lastSession.v1"), "beta-session");
    assert.equal(raw.getItem("unrelated-home-assistant-key"), "preserve");
    const fallback = openFrame(await launchedBootstrap(root, "beta", true), raw, session);
    assert.equal(fallback.__HA_OPENCODE_STORAGE_SCOPE__, "ha-opencode-beta");
    assert.equal(fallback.localStorage.getItem("lastDirectory"), "/homeassistant");
  } finally { await rm(root, { recursive: true, force: true }); }
});
