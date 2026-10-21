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
import { createNativeMcpHandler } from "../rootfs/opt/ha-mcp-server/lib/native-mcp-handler.js";
import { contextUri, nativeResult, tools } from "../rootfs/opt/ha-mcp-server/test/fixtures/ha-native-2026.10.mjs";
import { buildReadOnlyPermissions } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { resolveMcpConfiguration } from "../rootfs/opt/opencode-v2-homeassistant/mcp-config.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));

for (const scenario of [
  { name: "bundled plus native Assist", bundled: true, selection: "assist", apiId: "", prompt: "Assist", path: "/api/mcp/assist" },
  { name: "native-only HA configuration", bundled: false, selection: "home_assistant", apiId: "", prompt: "YourMcpApi", path: "/api/mcp" },
  { name: "native-only specific API", bundled: false, selection: "custom", apiId: "fixture-api", prompt: "FixtureApi", path: "/api/mcp/fixture-api" },
]) {
test(`pinned V2 loads first-session tools, prompts and resources with ${scenario.name}`, { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-native-v2-"));
  const requests = [], bridgePaths = [], generations = [], nextCalls = [];
  let server, logs = "", snapshot = "fixture snapshot one";
  const upstream = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const message = JSON.parse(Buffer.concat(parts));
    requests.push({ path: req.url, message, authorization: req.headers.authorization });
    const result = nativeResult(message, { snapshot, promptName: scenario.prompt });
    res.writeHead(result ? 200 : 202, { "content-type": "application/json" });
    res.end(result ? JSON.stringify(result) : undefined);
  });
  let handler;
  const bridge = createServer(async (req, res) => {
    bridgePaths.push(req.url);
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (req.headers.authorization !== `Bearer ${"a".repeat(64)}`) { res.writeHead(401); res.end(); return; }
    const parts = [];
    for await (const part of req) parts.push(part);
    const message = JSON.parse(Buffer.concat(parts));
    const result = req.url === "/mcp"
      ? (message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: "2025-11-25", serverInfo: { name: "addon-fixture", version: "1" }, capabilities: { tools: {} } } : { tools: [] } })
      : await handler(message, { protocolVersion: req.headers["mcp-protocol-version"] });
    res.writeHead(result ? 200 : 202, { "content-type": "application/json" });
    res.end(result ? JSON.stringify(result) : undefined);
  });
  const provider = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    generations.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = nextCalls.shift();
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
    for (const name of ["home", "config", "data", "state", "cache", "project"]) await mkdir(join(root, name));
    for (const mock of [upstream, bridge, provider]) await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const resolved = resolveMcpConfiguration({ provenance: "current", options: {
      mcp_enabled: scenario.bundled, native_ha_mcp_enabled: true,
      native_ha_mcp_selection: scenario.selection, native_ha_mcp_api_id: scenario.apiId,
    } });
    handler = createNativeMcpHandler({ supervisorToken: "fixture-supervisor", baseUrl: `http://127.0.0.1:${upstream.address().port}/api`,
      apiId: resolved.native.apiId, endpointMode: resolved.native.endpointMode });
    // Exercise the production registration path. Replace only the native FFI
    // credential broker with a synthetic credential in this isolated fixture.
    const pluginDir = join(root, "fixture-plugin");
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "native-fixture", type: "module", exports: "./index.js" }));
    await writeFile(join(pluginDir, "index.js"), `
      import { Plugin } from "@opencode/plugin";
      import { Rpc } from "@opencode/plugin/rpc";
      import { createSetup } from ${JSON.stringify(pathToFileURL(join(runtime, "plugin.js")).href)};
      const readiness = Rpc.define({ id: "native-fixture-readiness", methods: { tools: {
        input: { type: "object", properties: {}, additionalProperties: false },
        output: { type: "array", items: { type: "string" } },
        errors: {},
      } }, events: {} });
      export default Plugin.define({ id: "native-fixture", async setup(ctx) {
        const cleanup = await createSetup({ readSecret: async () => "a".repeat(64) })(ctx);
        // Test-only read of the real registry: no production API, remote tool
        // invocation, home snapshot or model warmup is used as a readiness proxy.
        const registration = await ctx.rpc.register(readiness, {
          tools: async () => (await ctx.tool.list()).map(({ id }) => id),
        });
        return async () => { await registration.dispose(); await cleanup(); };
      } });
    `);
    const configPath = join(root, "managed.json");
    await writeFile(configPath, JSON.stringify({
      model: "fixture/coding",
      providers: { fixture: {
        name: "Fixture", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
        models: { coding: { modelID: "fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } } },
      } },
      plugins: [{ package: pathToFileURL(pluginDir).href, options: {
        bundledEnabled: resolved.bundled.enabled,
        ...(resolved.bundled.enabled ? { endpoint: `http://127.0.0.1:${bridge.address().port}/mcp` } : {}),
        nativeEnabled: true, nativeEndpoint: `http://127.0.0.1:${bridge.address().port}/native-mcp`,
      } }],
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      agents: { "fixture-reader": { mode: "primary", permissions: buildReadOnlyPermissions() } },
    }));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    server = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: join(root, "project"), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_SERVER_PASSWORD: "fixture-password" },
    });
    for (const pipe of [server.stdout, server.stderr]) pipe.on("data", (chunk) => { logs += chunk; });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` } });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await sleep(50); }
    }
    assert.ok(ready, "isolated pinned server readiness");
    assert.equal((await client.server.info()).version, "2.1.2");
    // Location/plugin activation and catalog loading are asynchronous.
    // Wait for the actual MCP connection, not prompts or a warmup model request.
    let connectionReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const connections = (await client.mcp.list()).data;
      if (connections.find(({ name }) => name === "homeassistant_native")?.status.status === "connected") {
        connectionReady = true; break;
      }
      await sleep(50);
    }
    assert.ok(connectionReady, "native connection must become ready; plugin=" +
      JSON.stringify((await client.plugin.list()).data.find(({ id }) => id === "native-fixture")?.state));
    assert.deepEqual((await client.mcp.list()).data.map(({ name }) => name).sort(),
      (scenario.bundled ? ["homeassistant", "homeassistant_native"] : ["homeassistant_native"]));
    let toolIds = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      toolIds = (await client.rpc.call({ rpcID: "native-fixture-readiness", method: "tools", input: {} })).output;
      if (tools.every(({ name }) => toolIds.includes(`homeassistant_native_${name}`))) break;
      await sleep(50);
    }
    assert.ok(tools.every(({ name }) => toolIds.includes(`homeassistant_native_${name}`)),
      "actual native tool registry must load before the first provider request");
    let session = await client.session.create({ title: "first-session fixture" });
    await client.session.prompt({ sessionID: session.id, text: "Reply briefly without using tools." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
    assert.ok(generations.length > 0, "first session must reach the synthetic provider");
    const firstTools = generations[0].tools.map(({ function: fn }) => fn);
    for (const tool of tools) {
      const emitted = firstTools.find(({ name }) => name === `homeassistant_native_${tool.name}`);
      assert.ok(emitted, `first provider request must include ${tool.name}; tools=${JSON.stringify(firstTools.map(({ name }) => name))}; methods=${JSON.stringify(requests.map(({ message }) => message.method))}`);
      assert.deepEqual(emitted.parameters.required, tool.inputSchema.required);
    }
    let catalogReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const commands = await client.command.list();
      if (commands.data.some(({ name }) => name === `homeassistant_native:${scenario.prompt}`)) { catalogReady = true; break; }
      await sleep(50);
    }
    assert.ok(catalogReady, "native prompt catalog must load; commands=" +
      JSON.stringify((await client.command.list()).data.map(({ name }) => name)) +
      "; methods=" + JSON.stringify(requests.map(({ message }) => message.method)));
    const catalog = await client.mcp.resource.catalog();
    assert.ok(catalog.data.resources.some(({ server, uri }) => server === "homeassistant_native" && uri === contextUri));
    assert.equal(requests.filter(({ message }) => ["prompts/get", "resources/read", "tools/call"].includes(message.method)).length, 0,
      "catalog loading must not fetch a home snapshot");
    session = await client.session.create({ title: "native fixture" });
    await client.session.command({ sessionID: session.id, name: `homeassistant_native:${scenario.prompt}`, text: "" });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
    assert.ok(requests.some(({ message }) => message.method === "prompts/get" && message.params.name === scenario.prompt));
    assert.ok(generations.length > 0, "prompt command must reach the provider");
    assert.ok(JSON.stringify(generations.at(-1).messages).includes(`selected API prompt: ${scenario.prompt}`));
    assert.ok(JSON.stringify(generations.at(-1).messages).includes("Native tool errors are failures"));
    await client.session.prompt({ sessionID: session.id, text: "Use the selected API for the following requests." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
    const emitted = generations.at(-1).tools.map(({ function: fn }) => fn);
    const light = emitted.find(({ name }) => name === "homeassistant_native_light__FixtureSet");
    assert.ok(light, JSON.stringify(emitted.map(({ name }) => name)));
    assert.deepEqual(light.parameters.required, tools[1].inputSchema.required);
    const call = async (sessionID, name, args) => {
      nextCalls.push({ name, arguments: JSON.stringify(args) });
      await client.session.prompt({ sessionID, text: "Run the synthetic fixture call." });
      await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(10000) });
      return generations.at(-1).messages.filter(({ role }) => role === "tool").at(-1)?.content;
    };
    const liveName = "homeassistant_native_homeassistant__GetLiveContext";
    assert.ok((await call(session.id, liveName, {})).includes("fixture snapshot one"));
    snapshot = "fixture snapshot two";
    assert.ok((await call(session.id, liveName, {})).includes("fixture snapshot two"));
    assert.ok((await call(session.id, light.name, { name: "Fixture", brightness: 20 })).includes("fixture denied"));
    const calls = requests.filter(({ message }) => message.method === "tools/call");
    assert.deepEqual(calls.map(({ message }) => message.params.name), [tools[0].name, tools[0].name, tools[1].name]);
    assert.deepEqual(calls.at(-1).message.params.arguments, { name: "Fixture", brightness: 20 });
    await call(session.id, light.name, { name: "Fixture" });
    assert.equal(requests.filter(({ message }) => message.method === "tools/call").length, calls.length,
      "missing required brightness must be rejected before forwarding");
    assert.equal(calls.some(({ message }) => message.params._meta?.["io.home-assistant/device_id"] !== undefined), false);
    const reader = await client.session.create({ title: "read-only fixture", agent: "fixture-reader" });
    await call(reader.id, liveName, {});
    assert.equal(generations.at(-1).tools.some(({ function: fn }) => fn.name === liveName), false);
    assert.equal(requests.filter(({ message }) => message.method === "tools/call").length, calls.length,
      "readOnlyHint must not override the read-only agent's native MCP deny rule");
    assert.equal(requests.every(({ path }) => path === scenario.path), true);
    if (!scenario.bundled) assert.equal(bridgePaths.includes("/mcp"), false, "native-only must not contact the bundled route");
    assert.equal(requests.every(({ authorization }) => authorization === "Bearer fixture-supervisor"), true);
    assert.ok(!logs.includes("fixture-supervisor"));
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit"); server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      await exited; clearTimeout(timer);
    }
    for (const mock of [upstream, bridge, provider]) {
      mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
}
