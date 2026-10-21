import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode, isAgentNotFoundError } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { createAgentStore, encodeAgentFile } from "../rootfs/opt/opencode-v2-homeassistant/agents-store.js";
import { createAgentSettingsBridge } from "../rootfs/opt/opencode-v2-homeassistant/agent-settings.js";
import { createAgentImporter, initializeAgentImporter } from "../rootfs/opt/opencode-v2-homeassistant/agents-importer.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const matches = (pattern, value) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".") + "$", process.platform === "win32" ? "i" : "").test(value);
const effect = (agent, action, resource) => agent.permissions.filter(rule => matches(rule.action, action) && matches(rule.resource, resource)).at(-1)?.effect;

test("pinned V2 activates persisted UI agents, enforces policy, reloads, deletes and restores builtins across restart", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-agent-runtime-"));
  let server, logs = "";
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = once(server, "exit"); server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
    await exited; clearTimeout(timer);
  };
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project", "other-project", "persistent"]) await mkdir(join(root, name));
    const store = createAgentStore(join(root, "persistent"));
    await store.replace("agents/team/reviewer.md", null, encodeAgentFile({ description: "Persistent reviewer", mode: "subagent", model: "fixture/coding#careful", system: "Synthetic review instructions.", permissions: [{ action: "shell", resource: "*", effect: "deny" }] }));
    await store.replace("agents/build.md", null, encodeAgentFile({ description: "Opgeslagen bouwagent", permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }] }));
    await writeFile(join(root, "persistent/agents/home-assistant-read-only.md"), encodeAgentFile({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }), { mode: 0o600 });
    await writeFile(join(root, "persistent/opencode.json"), '{"agents":{"must-not-load":{"description":"Unrelated global config"}}}');
    const config = buildManagedConfig({ workspace: join(root, "project").replaceAll("\\", "/") });
    config.plugins = [];
    config.skills = [];
    const configFile = join(root, "managed.json"); await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await initializeAgentImporter(configFile, { basePath: join(root, "agents-base.json"), store });
    const importer = createAgentImporter({ base: config, store, managedPath: configFile });
    const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:agent-fixture").toString("base64")}` } });
    const location = { directory: join(root, "project") };
    const launch = async () => {
      server = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: location.directory, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG: configFile, OPENCODE_SERVER_PASSWORD: "agent-fixture", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "true" } });
      for (const pipe of [server.stdout, server.stderr]) pipe.on("data", chunk => { logs += chunk; });
      for (let attempt = 0; attempt < 150; attempt++) {
        try { await client.agent.get({ agentID: "team/reviewer", location }, { signal: AbortSignal.timeout(1000) }); return; } catch { await sleep(50); }
      }
      assert.fail("Agent importer startup: " + logs);
    };
    await launch();
    const get = async id => (await client.agent.get({ agentID: id, location })).data;
    const bridge = createAgentSettingsBridge({ store, client, importer, base: config, workspace: location.directory });
    assert.equal((await get("team/reviewer")).description, "Persistent reviewer");
    assert.deepEqual((await get("team/reviewer")).model, { providerID: "fixture", id: "coding", variant: "careful" });
    assert.equal((await get("build")).description, "Opgeslagen bouwagent");
    assert.equal(effect(await get("build"), "read", "secrets.yaml"), "deny");
    assert.equal(effect(await get("build"), "edit", "safe.yaml"), "ask");
    assert.equal(effect(await get("home-assistant-read-only"), "shell", "echo unsafe"), "deny");
    await assert.rejects(get("must-not-load"), isAgentNotFoundError);
    await bridge.handle("create", "helper", { description: "Saved in Settings", mode: "all", system: "Do not mutate files", permissions: [{ action: "edit", resource: "*", effect: "deny" }] });
    assert.equal(effect(await get("helper"), "edit", "safe.yaml"), "deny");
    await bridge.handle("update", "helper", { description: "Changed in Settings", color: "#112233" });
    assert.equal((await get("helper")).description, "Changed in Settings");
    const other = { directory: join(root, "other-project") };
    // A new Location initially exposes builtins while its config initializes.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await client.agent.get({ agentID: "helper", location: other })).data.description === "Changed in Settings") break; } catch (error) { if (!isAgentNotFoundError(error)) throw error; }
      await sleep(50);
    }
    assert.equal((await client.agent.get({ agentID: "helper", location: other })).data.description, "Changed in Settings");
    assert.equal(effect((await client.agent.get({ agentID: "helper", location: other })).data, "edit", "safe.yaml"), "deny");
    await bridge.handle("update", "helper", { color: null });
    assert.equal((await get("helper")).color, undefined, "activation includes optional field removal");
    const file = join(root, "persistent/agents/helper.md");
    await writeFile(file, encodeAgentFile({ description: "Manual edit reload", mode: "primary" }));
    await importer.refresh();
    for (let attempt = 0; attempt < 100 && (await get("helper")).description !== "Manual edit reload"; attempt++) await sleep(50);
    assert.equal((await get("helper")).description, "Manual edit reload");
    for (let attempt = 0; attempt < 100 && (await client.agent.get({ agentID: "helper", location: other })).data.description !== "Manual edit reload"; attempt++) await sleep(50);
    assert.equal((await client.agent.get({ agentID: "helper", location: other })).data.description, "Manual edit reload", "already-loaded locations also receive refreshes");
    await writeFile(file, "---\nsystem: '{file:private-fixture-must-not-load}'\n---\n");
    const refreshed = await importer.refresh();
    assert.ok(refreshed.rejected.some(error => error.id === "helper"));
    assert.equal((await get("helper")).description, "Manual edit reload", "invalid edits retain the last validated definition");
    assert.ok(!logs.includes("private-fixture-must-not-load"));
    await writeFile(file, encodeAgentFile({ description: "Valid again" }));
    await bridge.handle("update", "helper", { disabled: true });
    await assert.rejects(get("helper"), isAgentNotFoundError);
    assert.ok((await bridge.handle("disabled")).agents.includes("helper"));
    await bridge.handle("update", "helper", { disabled: null, description: "Survives restart" });
    await stop(); await launch();
    assert.equal((await get("helper")).description, "Survives restart");
    await bridge.handle("delete", "build");
    assert.match((await get("build")).description, /default agent/i);
    await bridge.handle("delete", "helper");
    await assert.rejects(get("helper"), isAgentNotFoundError);
    assert.ok(!(await readFile(configFile, "utf8")).includes("OPENCHAMBER_AGENT_TOOL_TOKEN"));
  } finally { await stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
