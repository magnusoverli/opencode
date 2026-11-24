import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { buildReadOnlyPermissions, buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { createSupervisorAppManager } from "../rootfs/opt/ha-mcp-server/lib/supervisor-app-management.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const names = ["get_agent_capabilities", "supervisor_app_inspect", "supervisor_app_preview", "supervisor_app_apply"];
const tools = names.map(name => ({ name, description: name,
  inputSchema: { type: "object", properties: {}, additionalProperties: true } }));

for (const codemode of [false, true]) test(`pinned runtime reports reader tools and transfers a preview to Build with separate approval (Code Mode ${codemode})`, { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-review-v2-"));
  const generations = [], nextCalls = [], calls = [];
  let backend, saves = 0;
  const info = { slug: "other", name: "Example", version: "1", state: "started",
    options: { enabled: false }, schema: [{ name: "enabled", type: "boolean" }] };
  const manager = createSupervisorAppManager({ selfSlug: async () => "opencode", apps: {
    info: async () => structuredClone(info),
    validateOptions: async () => ({ valid: true }),
    setOptions: async (_slug, options) => { saves++; info.options = structuredClone(options); },
    lifecycle: async () => { throw new Error("Unexpected lifecycle write"); },
  } });
  const bridge = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const parts = [];
    for await (const part of req) parts.push(part);
    const message = JSON.parse(Buffer.concat(parts));
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    switch (message.method) {
      case "initialize":
        result = { protocolVersion: "2025-11-25", serverInfo: { name: "review-fixture", version: "1" }, capabilities: { tools: {} } };
        break;
      case "tools/list": result = { tools }; break;
      case "tools/call": {
        const { name, arguments: args } = message.params;
        calls.push(name);
        const data = name === names[0]
          ? { mcp: { scope: "configured_server_catalogue", tools: names.length, tool_names: names } }
          : name === names[1] ? await manager.inspect(args.slug)
            : name === names[2] ? await manager.preview(args) : await manager.apply(args.preview_id, args.review);
        result = { content: [{ type: "text", text: JSON.stringify(data) }] };
        break;
      }
      default: result = {};
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const provider = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    const codeTool = body.tools?.find(tool => tool.function?.name === "execute");
    const primary = !!codeTool || body.tools?.some(tool => tool.function?.name === `homeassistant_${names[0]}`);
    if (primary) generations.push(body);
    let call = primary ? nextCalls.shift() : null;
    if (call && codeTool && codemode && !body.tools.some(tool => tool.function?.name === call.name)) {
      call = { name: "execute", arguments: JSON.stringify({
        code: `return await tools.homeassistant.${call.name.slice("homeassistant_".length)}(${call.arguments});`,
      }) };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = call
      ? [[{ role: "assistant", tool_calls: [{ index: 0, id: `call_${generations.length}`, type: "function", function: call }] }, null], [{}, "tool_calls"]]
      : [[{ role: "assistant", content: "Fixture response" }, null], [{}, "stop"]];
    for (const [delta, finish_reason] of chunks) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project", "plugin"]) await mkdir(join(root, name));
    for (const server of [bridge, provider]) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    await writeFile(join(root, "plugin/package.json"), JSON.stringify({ name: "review-fixture", type: "module", exports: "./index.js" }));
    await writeFile(join(root, "plugin/index.js"), `
      import { Plugin } from "@opencode/plugin";
      import { createSetup } from ${JSON.stringify(pathToFileURL(join(runtime, "plugin.js")).href)};
      export default Plugin.define({ id: "review-fixture", setup: createSetup({ readSecret: async () => "a".repeat(64) }) });
    `);
    const config = join(root, "managed.json");
    await writeFile(config, JSON.stringify({
      model: "fixture/coding", update: "disable", share: "disabled", snapshots: false,
      plugins: [{ package: pathToFileURL(join(root, "plugin")).href,
        options: { endpoint: `http://127.0.0.1:${bridge.address().port}/mcp`, codemode } }],
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        ...buildManagedConfig().permissions.filter(rule => rule.action === "homeassistant_supervisor_app_apply"),
      ],
      agents: { "fixture-reader": { mode: "primary", permissions: buildReadOnlyPermissions() } },
      providers: { fixture: { name: "Fixture", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
        models: { coding: { modelID: "fixture", limit: { context: 32000, output: 1000 } } } } },
    }));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    // The pinned npm package installs bin/opencode.exe on every platform.
    backend = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"),
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: join(root, "project"), stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_SERVER_PASSWORD: "synthetic-review-password" },
      });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
      headers: { Authorization: `Basic ${Buffer.from("opencode:synthetic-review-password").toString("base64")}` } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await sleep(50); }
    }
    assert.ok(ready, "isolated pinned backend must start");
    assert.equal((await client.server.info()).version, "2.4.1");
    let connected = false;
    for (let i = 0; i < 100; i++) {
      if ((await client.mcp.list()).data.some(item => item.name === "homeassistant" && item.status.status === "connected")) {
        connected = true; break;
      }
      await sleep(50);
    }
    assert.ok(connected, "production plugin must register the fixture MCP");
    await client.credential.create({ integrationID: "fixture", value: { type: "key", key: "synthetic-provider" } });
    const session = await client.session.create({ title: "Supervisor review fixture", agent: "fixture-reader" });
    const start = async (name, args = {}) => {
      nextCalls.push({ name: `homeassistant_${name}`, arguments: JSON.stringify(args) });
      await client.session.prompt({ sessionID: session.id, text: "Run the synthetic fixture call." });
    };
    const wait = () => client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
    const lastResult = () => {
      let result = generations.at(-1).messages.filter(item => item.role === "tool").at(-1)?.content;
      // Code Mode wraps the MCP result; direct-tool responses contain its text.
      for (let i = 0; i < 5; i++) {
        const parsed = typeof result === "string" ? JSON.parse(result) : result;
        if (parsed?.mcp || parsed?.status || parsed?.revision || parsed?.preview_id) return JSON.stringify(parsed);
        result = parsed?.content?.[0]?.text ?? parsed?.result ?? parsed;
      }
      return typeof result === "string" ? result : JSON.stringify(result);
    };
    const call = async (name, args) => { await start(name, args); await wait(); return lastResult(); };
    const reader = JSON.parse(await call(names[0]));
    assert.equal(reader.mcp.tools, 4);
    assert.equal(reader.mcp.current_agent.status, "observed");
    assert.equal(reader.mcp.current_agent.agent_id, "fixture-reader");
    assert.deepEqual(reader.mcp.current_agent.tool_names, names.slice(0, 3).sort());
    assert.equal(generations.at(-1).tools.some(tool => tool.function.name === `homeassistant_${names[3]}`), false);
    const inspected = JSON.parse(await call(names[1], { slug: "other" }));
    const plan = JSON.parse(await call(names[2], { slug: "other", expected_revision: inspected.revision, changes: { enabled: true } }));
    assert.equal(plan.review.diff[0].after.value, true);
    assert.equal(saves, 0);
    const apply = { preview_id: plan.preview_id, review: plan.review };
    await call(names[3], apply);
    assert.equal(calls.includes(names[3]), false, "read-only apply must not reach MCP even if the model requests it");
    if (codemode) {
      nextCalls.push({ name: "execute", arguments: JSON.stringify({
        code: `return await tools.homeassistant.supervisor_app_apply(${JSON.stringify(apply)});`,
      }) });
      await client.session.prompt({ sessionID: session.id, text: "Attempt the unavailable executor." });
      await wait();
      assert.equal(calls.includes(names[3]), false, "read-only must also reject invented Code Mode execution");
    }
    await client.session.switchAgent({ sessionID: session.id, agent: "build" });
    const builder = JSON.parse(await call(names[0]));
    assert.equal(builder.mcp.current_agent.agent_id, "build");
    if (codemode) {
      assert.equal(builder.mcp.current_agent.status, "unknown");
      assert.equal(builder.mcp.current_agent.code_mode, true);
      assert.ok(builder.mcp.current_agent.direct_tool_names.includes(names[3]));
      assert.ok(!generations.at(-1).tools.some(tool => tool.function?.name === `homeassistant_${names[1]}`));
      assert.ok(generations.at(-1).tools.some(tool => tool.function?.name === "execute"));
      const before = calls.filter(name => name === names[1]).length;
      await call(names[1], { slug: "other" });
      assert.equal(calls.filter(name => name === names[1]).length, before + 1, "Code Mode read reaches the registered MCP");
      nextCalls.push({ name: "execute", arguments: JSON.stringify({
        code: `return await tools.homeassistant.supervisor_app_apply(${JSON.stringify(apply)});`,
      }) });
      await client.session.prompt({ sessionID: session.id, text: "Attempt to bypass the direct-only review tool." });
      await wait();
      assert.equal(saves, 0, "direct-only apply is not callable through the Code Mode catalogue");
      assert.equal(calls.includes(names[3]), false);
    } else assert.ok(builder.mcp.current_agent.tool_names.includes(names[3]));
    await start(names[3], apply);
    let approval;
    for (let i = 0; i < 100; i++) {
      approval = (await client.permission.list({ sessionID: session.id }))[0];
      if (approval) break;
      await sleep(50);
    }
    assert.ok(approval, "Build apply must ask separately after read-only preview");
    assert.equal(saves, 0);
    assert.equal(calls.includes(names[3]), false, "apply must wait for approval before reaching MCP");
    await client.permission.reply({ sessionID: session.id, requestID: approval.id, decision: "once" });
    await wait();
    assert.equal(JSON.parse(lastResult()).status, "saved");
    assert.equal(saves, 1);
  } finally {
    if (backend && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, "exit"); backend.kill("SIGTERM");
      const timer = setTimeout(() => backend.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    for (const server of [bridge, provider]) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
