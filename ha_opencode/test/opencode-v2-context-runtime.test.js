import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { buildManagedConfig, READ_ONLY_AGENT_ID } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const marker = "context-runtime-fixture-briefing";

test("pinned V2 sends managed context once on initial and tool-continuation HTTP requests", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-v2-context-runtime-"));
  let server;
  let logs = "";
  const requests = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.tools ?? [];
    const primary = tools.some((tool) => tool.function?.name === "fixture_read");
    if (primary) requests.push(body);
    const continuation = body.messages.some((message) => message.role === "tool");
    const lspBoundary = JSON.stringify(body.messages).includes("lsp-boundary-fixture");
    const toolCall = (primary || lspBoundary) && !continuation;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    chunk({ role: "assistant", ...(toolCall ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: lspBoundary ? "ha_yaml_status" : "fixture_read", arguments: "{}" } }] } : { content: "Fixture complete" }) });
    chunk({}, toolCall ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    for (const leaf of ["home", "config", "data", "state", "cache", "project", "plugin"]) {
      await mkdir(join(root, leaf));
    }
    await writeFile(join(root, "plugin/package.json"), '{"type":"module"}');
    const briefing = join(root, "briefing.md");
    await writeFile(briefing, marker);
    await writeFile(join(root, "plugin/index.js"), `
      import { appendFileSync, writeFileSync } from "node:fs";
      import { Plugin } from "@opencode/plugin";
      import { createContextSetup, readContextSource } from ${JSON.stringify(pathToFileURL(join(runtime, "context.js")).href)};
      import { createLspSetup } from ${JSON.stringify(pathToFileURL(join(runtime, "lsp.js")).href)};
      export default Plugin.define({ id: "fixture.context", async setup(ctx) {
        const dispose = await createContextSetup({ readSource: () => readContextSource(${JSON.stringify(briefing)}) })(ctx);
        const tool = await ctx.tool.transform((editor) => editor.add({
          name: "fixture_read", description: "Read the synthetic fixture", input: { type: "object", properties: {} },
          options: { codemode: false }, execute: async () => {
            // Like an approved decision write, publish updated bounded context
            // during a tool call. The continuation must see it without reload.
            writeFileSync(${JSON.stringify(briefing)}, ${JSON.stringify(`${marker}-after-tool`)});
            return { content: "fixture-tool-result" };
          },
        }));
        const disposeLsp = await createLspSetup({ request: async () => {
          appendFileSync(${JSON.stringify(join(root, "lsp-calls"))}, "x");
          return { authenticated: true, core_version: "fixture" };
        } })(ctx);
        return async () => { await disposeLsp(); await dispose(); await tool.dispose(); };
      } });
    `);
    const config = join(root, "managed.json");
    await writeFile(config, JSON.stringify({
      autoupdate: false, snapshots: false, lsp: false,
      permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "fixture_read", resource: "*", effect: "allow" }, { action: "lsp", resource: "*", effect: "allow" }],
      plugins: [{ package: join(root, "plugin"), options: { files: ["/data/context/home-briefing.md"] } }],
      agents: buildManagedConfig().agents,
      providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-key" },
        models: { "fixture-model": { name: "Fixture model", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128000, output: 1000 } } },
      } },
      model: "fixture/fixture-model",
    }));
    server = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], {
      cwd: join(root, "project"), stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_SERVER_PASSWORD: "fixture-server-password", SUPERVISOR_TOKEN: "must-not-reach-model-context",
      },
    });
    for (const pipe of [server.stdout, server.stderr]) pipe.on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
    const client = OpenCode.make({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-server-password").toString("base64")}` },
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await sleep(50); }
    }
    assert.ok(ready, logs);
    const session = await client.session.create({ title: "Context fixture", model: { providerID: "fixture", id: "fixture-model" } });
    await client.session.prompt({ sessionID: session.id, text: "Read the synthetic fixture and finish." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
    assert.equal(requests.length, 2, `${logs}\n${JSON.stringify(await client.session.context({ sessionID: session.id }))}`);
    assert.ok(!JSON.stringify(requests[0]).includes(`${marker}-after-tool`));
    assert.ok(JSON.stringify(requests[1]).includes(`${marker}-after-tool`), "Tool-time context refresh must reach the existing session's continuation without location reload");
    assert.ok(requests[0].tools.some((tool) => tool.function?.name === "ha_yaml_status"), JSON.stringify(requests[0].tools.map((tool) => tool.function?.name)) + logs);
    await writeFile(briefing, `${marker}-updated`);
    await client.location.reload();
    await client.session.prompt({ sessionID: session.id, text: "Resume after context refresh." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
    assert.equal(requests.length, 3, logs);
    assert.ok(JSON.stringify(requests[2]).includes(`${marker}-updated`));
    for (const request of requests) {
      const body = JSON.stringify(request);
      assert.equal(body.split(marker).length - 1, 1);
      assert.doesNotMatch(body, /must-not-reach-model-context/);
    }
    assert.ok(requests[1].messages.some((message) => message.role === "tool" && JSON.stringify(message).includes("fixture-tool-result")));
    const full = await client.session.create({ title: "LSP allowed", model: { providerID: "fixture", id: "fixture-model" } });
    await client.session.prompt({ sessionID: full.id, text: "lsp-boundary-fixture" });
    await client.session.wait({ sessionID: full.id }, { signal: AbortSignal.timeout(10000) });
    assert.equal(await readFile(join(root, "lsp-calls"), "utf8"), "x", "LSP allow must reach the registered handler");
    const readonly = await client.session.create({ title: "LSP denied", agent: READ_ONLY_AGENT_ID, model: { providerID: "fixture", id: "fixture-model" } });
    await client.session.prompt({ sessionID: readonly.id, text: "lsp-boundary-fixture" });
    await client.session.wait({ sessionID: readonly.id }, { signal: AbortSignal.timeout(10000) });
    assert.equal(await readFile(join(root, "lsp-calls"), "utf8"), "x", "Read-only must reject an invented LSP call before dispatch");
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const killTimer = setTimeout(() => server.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(killTimer);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
