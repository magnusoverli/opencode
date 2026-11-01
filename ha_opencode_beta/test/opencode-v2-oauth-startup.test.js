import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";

test("pinned runtime resolves OAuth methods after same-location integration activation without an account", { timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "oauth-activation-"));
  let server;
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project", "cold"]) await mkdir(join(root, name));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const binary = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/cli/bin/opencode.exe", import.meta.url));
    server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: join(root, "project"), stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_SERVER_PASSWORD: "synthetic-oauth-test-password", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: {
      Authorization: `Basic ${Buffer.from("opencode:synthetic-oauth-test-password").toString("base64")}`,
    } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; }
      catch { await sleep(50); }
    }
    assert.ok(ready, "isolated server was not ready");
    const location = { directory: join(root, "cold") };
    await client.integration.list({ location });
    // Starting an authorization creates a local callback listener and URL only.
    // Never open the URL, exchange a code, use an account or print OAuth state.
    const { data: attempt } = await client.integration.oauth.connect({ location, integrationID: "openai", methodID: "chatgpt-token-sharing" });
    assert.ok(attempt.attemptID);
    assert.equal(new URL(attempt.url).origin, "https://auth.openai.com");
    await client.integration.oauth.cancel({ location, integrationID: "openai", attemptID: attempt.attemptID });
    assert.deepEqual(await client.credential.list(), []);
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, "exit"); server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
