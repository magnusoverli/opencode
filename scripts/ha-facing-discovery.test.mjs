import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const channel of ["ha_opencode", "ha_opencode_beta"]) {
  const root = new URL(`../${channel}/rootfs/`, import.meta.url);
  const { createDiscoveryPublisher, runDiscoveryPublisher } = await import(new URL("opt/ha-mcp-server/ha-facing-discovery.js", root));
  const { runService } = await import(new URL("opt/ha-mcp-server/ha-facing-service.js", root));

  async function fixture(t) {
    const temp = mkdtempSync(join(tmpdir(), "ha-facing-discovery-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const directory = join(temp, "state");
    const secretPath = join(temp, "secret");
    writeFileSync(secretPath, "test-ipc-secret", { mode: 0o600 });
    const state = { ready: false, ipcStatus: 200, postStatus: 200, deleteStatus: 200,
      uuid: "uuid-one", calls: [], ipcCalls: 0 };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/ha-mcp/status") {
        state.ipcCalls++;
        assert.equal(req.headers["x-ha-mcp-ingress-secret"], readFileSync(secretPath, "utf8"));
        assert.equal(req.headers.authorization, undefined);
        res.writeHead(state.ipcStatus);
        res.end(JSON.stringify({ ready: state.ready, url: "http://test-addon:8766/mcp" }));
        return;
      }
      state.calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      assert.equal(req.headers.authorization, "Bearer test-supervisor-token");
      assert.equal(req.headers["x-ha-mcp-ingress-secret"], undefined);
      res.writeHead(req.method === "POST" ? state.postStatus : state.deleteStatus);
      res.end(JSON.stringify({ result: "ok", data: { uuid: state.uuid } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = { enabled: true, token: "test-supervisor-token", directory, secretPath,
      statusUrl: `${base}/ha-mcp/status`, supervisorUrl: `${base}/discovery` };
    const path = join(directory, "discovery.json");
    return { state, options, path, publisher: createDiscoveryPublisher(options),
      read: () => JSON.parse(readFileSync(path, "utf8")) };
  }

  test(`${channel}: authenticated readiness, periodic POST and atomic UUID replacement`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.publisher.tick(), false);
    assert.equal(f.state.calls.length, 0);
    f.state.ready = true;
    assert.equal(await f.publisher.tick(), true);
    assert.deepEqual(f.read(), { uuid: "uuid-one" });
    f.state.uuid = "uuid-two";
    writeFileSync(f.options.secretPath, "rotated-ipc-secret");
    await f.publisher.tick();
    assert.deepEqual(f.read(), { uuid: "uuid-two" });
    assert.equal(f.state.calls.length, 2);
    for (const call of f.state.calls) {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "/discovery");
      assert.deepEqual(JSON.parse(call.body), { service: "mcp", config: { url: "http://test-addon:8766/mcp" } });
    }
    assert.deepEqual(readdirSync(f.options.directory), ["discovery.json"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(f.path).mode & 0o777, 0o600);
      assert.equal(statSync(f.options.directory).mode & 0o777, 0o700);
    }
  });

  test(`${channel}: auth errors, malformed UUID and temporary readiness loss retain registration`, async (t) => {
    const f = await fixture(t);
    f.state.ready = true;
    await f.publisher.tick();
    for (const code of [401, 403, 500]) {
      f.state.postStatus = code;
      await assert.rejects(f.publisher.tick(), /discovery_publish_failed/);
      assert.deepEqual(f.read(), { uuid: "uuid-one" });
    }
    f.state.postStatus = 200;
    f.state.uuid = "../../unsafe";
    await assert.rejects(f.publisher.tick(), /invalid_discovery_response/);
    f.state.ready = false;
    assert.equal(await f.publisher.tick(), false);
    f.state.ipcStatus = 403;
    await assert.rejects(f.publisher.tick(), /readiness_failed/);
    assert.deepEqual(f.read(), { uuid: "uuid-one" });
    assert.ok(f.state.calls.every((call) => call.method === "POST"));
    f.state.ipcStatus = 200; f.state.ready = true; f.state.uuid = "uuid-recovered";
    await f.publisher.tick();
    assert.deepEqual(f.read(), { uuid: "uuid-recovered" });
  });

  test(`${channel}: disabled startup retains failed deletion intent and retries across restart, including 404`, async (t) => {
    const f = await fixture(t);
    f.state.ready = true;
    await f.publisher.tick();
    const ipcCalls = f.state.ipcCalls;
    const disabled = createDiscoveryPublisher({ ...f.options, enabled: false });
    for (const code of [401, 403, 503]) {
      f.state.deleteStatus = code;
      await assert.rejects(disabled.tick(), /discovery_delete_failed/);
      assert.deepEqual(f.read(), { uuid: "uuid-one", pendingDelete: true });
    }
    f.state.deleteStatus = 404;
    await createDiscoveryPublisher({ ...f.options, enabled: false }).tick();
    assert.equal(existsSync(f.path), false);
    const calls = f.state.calls.length;
    await disabled.tick();
    assert.equal(f.state.calls.length, calls);
    assert.equal(f.state.ipcCalls, ipcCalls);
    assert.ok(f.state.calls.slice(1).every((call) => call.method === "DELETE" && call.url === "/discovery/uuid-one"));
    f.state.deleteStatus = 200;
    await f.publisher.tick();
    await disabled.tick();
    assert.equal(existsSync(f.path), false);
  });

  test(`${channel}: missing token retains intent; re-enable never deletes a pending UUID`, async (t) => {
    const f = await fixture(t);
    f.state.ready = true;
    await f.publisher.tick();
    await assert.rejects(createDiscoveryPublisher({ ...f.options, enabled: false, token: "" }).tick(), /supervisor_token_required/);
    assert.equal(f.read().pendingDelete, true);
    await f.publisher.tick();
    assert.deepEqual(f.read(), { uuid: "uuid-one" });
    assert.ok(f.state.calls.every((call) => call.method === "POST"));
  });

  test(`${channel}: retry is bounded, periodic success resets backoff and abort stops polling`, async () => {
    const controller = new AbortController();
    const delays = []; let attempts = 0; let warnings = 0;
    await runDiscoveryPublisher({ async tick() {
      attempts++;
      if (attempts === 9) return true;
      throw new Error("must-not-log-this-secret");
    } }, { signal: controller.signal, warn: (...args) => { assert.deepEqual(args, []); warnings++; },
      wait: async (delay) => { delays.push(delay); if (delays.length === 10) controller.abort(); },
    });
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 300000, 1000]);
    assert.equal(warnings, 9);
    assert.equal(attempts, 10);
  });

  test(`${channel}: wrapper skips disabled listener and closes enabled server without deleting on shutdown`, async (t) => {
    const f = await fixture(t);
    const signals = new EventEmitter();
    let launches = 0; let closes = 0;
    const launch = async () => { launches++; return { async close() { closes++; } }; };
    await runService({ HA_MCP_STATE_DIR: f.options.directory }, {
      launch, signals, publish: async (_publisher, { signal }) => { signals.emit("SIGTERM"); assert.equal(signal.aborted, true); },
    });
    assert.equal(launches, 0);
    f.state.ready = true; await f.publisher.tick();
    await runService({ HA_MCP_ENABLED: "true", HA_MCP_STATE_DIR: f.options.directory }, {
      launch, signals, publish: async () => { signals.emit("SIGTERM"); signals.emit("SIGINT"); },
    });
    assert.equal(launches, 1); assert.equal(closes, 1);
    assert.deepEqual(f.read(), { uuid: "uuid-one" });
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    await assert.rejects(runService({ HA_MCP_ENABLED: "true" }, {
      signals, launch: async () => { throw new Error("startup failed"); },
      publish: async () => assert.fail("must not publish after startup failure"),
    }), /startup failed/);
  });

  test(`${channel}: unsafe state is rejected before contacting Supervisor`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    mkdirSync(f.options.directory, { mode: 0o700 });
    chmodSync(f.options.directory, 0o755);
    await assert.rejects(f.publisher.tick(), /unsafe_discovery_state/);
    assert.equal(f.state.calls.length, 0);
  });

  test(`${channel}: independent s6 graph and fixed sanitized launch environment`, () => {
    const service = new URL("etc/s6-overlay/s6-rc.d/ha-facing-mcp/", root);
    assert.equal(readFileSync(new URL("type", service), "utf8"), "longrun\n");
    assert.deepEqual(readdirSync(new URL("dependencies.d/", service)), ["init-opencode"]);
    assert.equal(statSync(new URL("etc/s6-overlay/s6-rc.d/user/contents.d/ha-facing-mcp", root)).size, 0);
    const script = readFileSync(new URL("run", service), "utf8");
    assert.match(script, /umask 077/);
    assert.match(script, /enabled=false/);
    assert.match(script, /bashio::config 'ha_mcp_server_enabled'/);
    assert.match(script, /exec \/usr\/bin\/env -i/);
    assert.match(script, /HA_MCP_PORT=8766/);
    assert.match(script, /HA_MCP_INGRESS_PORT=8767/);
    assert.match(script, /HA_MCP_ENABLED="\$\{enabled\}"/);
    assert.doesNotMatch(script, /source |interface_mode|bashio::config 'mcp_enabled'|s6-setuidgid/);
    const assignments = [...script.slice(script.indexOf("exec ")).matchAll(/\b([A-Z_]+)=/g)].map((match) => match[1]);
    assert.deepEqual(assignments, ["PATH", "HOME", "HA_MCP_ENABLED", "HA_MCP_STATE_DIR", "HA_MCP_PORT", "HA_MCP_INGRESS_PORT", "SUPERVISOR_TOKEN"]);
  });
}

test("both channels ship identical discovery and service wiring", () => {
  for (const path of ["opt/ha-mcp-server/ha-facing-discovery.js", "opt/ha-mcp-server/ha-facing-service.js",
    "etc/s6-overlay/s6-rc.d/ha-facing-mcp/run", "etc/s6-overlay/s6-rc.d/ha-facing-mcp/type"]) {
    assert.equal(readFileSync(new URL(`../ha_opencode/rootfs/${path}`, import.meta.url), "utf8"),
      readFileSync(new URL(`../ha_opencode_beta/rootfs/${path}`, import.meta.url), "utf8"));
  }
});
