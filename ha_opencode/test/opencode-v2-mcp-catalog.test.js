import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { Client } from "../rootfs/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../rootfs/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

test("full MCP catalog including hab_run reaches the pinned model tool list (#214)", { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
  let backend;
  let requestBody;
  const requestSummaries = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requestSummaries.push({ model: body.model, toolCount: body.tools?.length ?? 0 });
    // Background title generation can issue a separate tool-free request.
    if (body.tools?.some(tool => tool.function?.name?.startsWith("homeassistant_"))) requestBody = body;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "fixture" }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  const command = [process.execPath, fileURLToPath(new URL("../rootfs/opt/ha-mcp-server/index.js", import.meta.url))];
  const environment = { SUPERVISOR_TOKEN: "synthetic-catalog-only", OPENCODE_MCP_TOOL_PROFILE: "full",
    OPENCODE_DECISION_NOTES: "false" };
  const direct = new Client({ name: "catalog-regression", version: "1" });
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project"]) await mkdir(join(root, name));
    await direct.connect(new StdioClientTransport({ command: command[0], args: command.slice(1),
      env: { PATH: process.env.PATH, HOME: join(root, "home"), ...environment }, stderr: "ignore" }));
    const advertised = (await direct.listTools()).tools.map(tool => `homeassistant_${tool.name}`).sort();
    assert.ok(advertised.includes("homeassistant_hab_run"));
    await direct.close();
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const config = join(root, "managed.json");
    await writeFile(config, JSON.stringify({
      model: "fixture/coding", autoupdate: false, share: "disabled", snapshots: false,
      mcp: { servers: { homeassistant: { type: "local", command, environment, codemode: false } } },
      providers: { fixture: { name: "Fixture", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
        models: { coding: { modelID: "fixture-model", name: "Fixture", limit: { context: 100000, output: 1000 } } } } },
    }));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    backend = spawn(fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/cli/bin/opencode.exe", import.meta.url)),
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: join(root, "project"), stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG: config, OPENCODE_SERVER_PASSWORD: "synthetic-catalog-password",
          OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
      headers: { Authorization: `Basic ${Buffer.from("opencode:synthetic-catalog-password").toString("base64")}` } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; }
      catch { await sleep(50); }
    }
    assert.ok(ready, "isolated backend must start");
    const location = { directory: join(root, "project") };
    let connected = false;
    for (let i = 0; i < 100; i++) {
      const { data } = await client.mcp.list({ location });
      if (data.some(server => server.name === "homeassistant" && server.status.status === "connected")) {
        connected = true; break;
      }
      await sleep(100);
    }
    assert.ok(connected, "full-profile MCP must connect before the model request");
    await client.credential.create({ integrationID: "fixture", value: { type: "key", key: "synthetic-provider" } });
    const session = await client.session.create({ location });
    await client.session.prompt({ sessionID: session.id, text: "Return fixture; do not call any tools." });
    for (let i = 0; i < 150 && !requestBody; i++) await sleep(100);
    assert.ok(requestBody, `mock provider must receive a tool-bearing model request: ${JSON.stringify(requestSummaries)}`);
    const received = (requestBody.tools ?? []).map(tool => tool.function.name).filter(name => name.startsWith("homeassistant_")).sort();
    assert.deepEqual(received, advertised, "no advertised full-profile tool may silently disappear");
  } finally {
    await direct.close().catch(() => {});
    if (backend && backend.exitCode === null) {
      const closed = once(backend, "exit"); backend.kill("SIGTERM");
      const timer = setTimeout(() => backend.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
