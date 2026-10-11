import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { buildManagedConfig, READ_ONLY_AGENT_ID } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const input = "outer:\n x: 1\nsecret: !secret fixture_value\ninclude: !include fixture.yaml\n";

test("pinned V2 preserves YAML by default, formats on opt-in, and denies read-only writes", { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-v2-format-"));
  const project = join(root, "project");
  let server;
  let logs = "";
  let pathKey;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const scenario = /format-fixture:(\w+)/.exec(JSON.stringify(body.messages))?.[1];
    const write = body.tools?.find((tool) => tool.function?.name === "write");
    if (write) pathKey = ["path", "filePath", "file_path"].find((name) => write.function.parameters.properties[name]);
    const call = scenario && pathKey && !body.messages.some((message) => message.role === "tool");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "formatter-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: "assistant", ...(call ? { tool_calls: [{ index: 0, id: "call_write", type: "function", function: {
      name: "write", arguments: JSON.stringify({ [pathKey]: join(project, `${scenario}.yaml`), content: input }),
    } }] } : { content: "Done" }) });
    send({}, call ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project"]) await mkdir(join(root, name));
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const managed = buildManagedConfig();
    const config = {
      autoupdate: false, snapshots: false, formatter: managed.formatter, agents: managed.agents,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "Formatter fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128000, output: 1000 } } },
      } },
      model: "fixture/fixture",
    };
    const configPath = join(root, "managed.json");
    await writeFile(configPath, JSON.stringify(config));
    server = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
      cwd: project, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${join(runtime, "node_modules/.bin")}${delimiter}${process.env.PATH}`, HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_SERVER_PASSWORD: "fixture-password",
      },
    });
    for (const pipe of [server.stdout, server.stderr]) pipe.on("data", (chunk) => { logs = (logs + chunk).slice(-6000); });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` } });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await sleep(50); }
    }
    assert.ok(ready, logs);
    async function run(scenario, agent = "build") {
      const session = await client.session.create({ title: scenario, agent, model: { providerID: "fixture", id: "fixture" } });
      await client.session.prompt({ sessionID: session.id, text: `format-fixture:${scenario}` });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(8000) });
    }
    await run("default");
    assert.equal(await readFile(join(project, "default.yaml"), "utf8"), input, logs);
    config.formatter = buildManagedConfig({ yamlFormatting: true }).formatter;
    await writeFile(configPath, JSON.stringify(config));
    await client.location.reload();
    await run("enabled");
    assert.equal(await readFile(join(project, "enabled.yaml"), "utf8"), input.replace("\n x:", "\n  x:"), logs);
    await writeFile(join(project, ".prettierrc.json"), '{"tabWidth":4}');
    await run("preferences");
    assert.equal(await readFile(join(project, "preferences.yaml"), "utf8"), input.replace("\n x:", "\n    x:"), logs);
    await run("denied", READ_ONLY_AGENT_ID);
    await assert.rejects(access(join(project, "denied.yaml")));
    config.formatter = false;
    await writeFile(configPath, JSON.stringify(config));
    await client.location.reload();
    await run("disabled");
    assert.equal(await readFile(join(project, "disabled.yaml"), "utf8"), input, logs);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
