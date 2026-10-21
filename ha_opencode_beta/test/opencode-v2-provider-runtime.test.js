import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode as RuntimeOpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";
import { createProxy } from "../rootfs/opt/ppq-private-runtime/proxy.js";
import { normalizeCatalog } from "../rootfs/opt/ppq-private-runtime/catalog.js";
import { Model } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/schema/dist/model.js";
import { Schema } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/effect/dist/index.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const providerKey = "fixture-provider-api-key-not-a-real-secret";
const ppqKey = "fixture-upstream-ppq-key-must-stay-out-of-backend";
// Optionally qualify OpenChamber's independently pinned SDK against this backend.
const upstream = process.env.OPENCHAMBER_TEST_SOURCE;
const OpenCode = upstream
  ? (await import(pathToFileURL(join(upstream, "packages/web/node_modules/@opencode/client/dist/promise/index.js")))).OpenCode
  : RuntimeOpenCode;

test("pinned V2 routes generated custom-provider and PPQ selections to controlled local endpoints", { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-v2-provider-"));
  const requests = [];
  const mock = (route) => createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ route, path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "Fixture response" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "provider-fixture", object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  const custom = mock("custom");
  // Exercise the shipped private adapter, not a permissive mock which accepts
  // obsolete model IDs. Only the cryptographic SDK is substituted: no paid call.
  const privateModels = normalizeCatalog({ data: [
    { id: "private/future-coder", type: "chat", privacyLevel: "e2e", context_length: 64000,
      supported_parameters: ["tools"], name: "Future Coder",
      pricing: { input_per_1M_tokens: 1.2, output_per_1M_tokens: 3.4, cache_read_per_1M_tokens: 0.3, cache_write_per_1M_tokens: 1.8 } },
    { id: "private/no-cache-rates", type: "chat", privacyLevel: "e2e", context_length: 64000,
      pricing: { input_per_1M_tokens: 2, output_per_1M_tokens: 4, cache_read_per_1M_tokens: null } },
    { id: "private/unpriced", type: "chat", privacyLevel: "e2e", context_length: 64000 },
  ] });
  const ppq = createProxy({ apiKey: ppqKey, catalog: { get: async () => privateModels }, secureClient: {
    async ready() {},
    async fetch(path, options) {
      const body = JSON.parse(options.body);
      requests.push({ route: "ppq", path, authorization: options.headers.Authorization, privateModel: options.headers["X-Private-Model"], body });
      const chunks = [[{ role: "assistant", content: "Fixture private response" }, null], [{}, "stop"]].map(([delta, finish_reason]) =>
        `data: ${JSON.stringify({ id: "private-fixture", object: "chat.completion.chunk", created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`).join("");
      return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    },
  } });
  let server;
  let logs = "";
  try {
    for (const name of ["home", "config", "data", "state", "cache", "project"]) await mkdir(join(root, name));
    await new Promise((resolve, reject) => custom.once("error", reject).listen(0, "127.0.0.1", resolve));
    // Binding the exact managed loopback port proves the emitted PPQ URL. If it
    // is occupied, fail before starting V2; never use an existing proxy/service.
    await new Promise((resolve, reject) => ppq.once("error", reject).listen(8787, "127.0.0.1", resolve));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));

    const input = join(root, "options.json");
    const environment = join(root, "provider-env");
    await writeFile(input, JSON.stringify({
      ppq_private_enabled: true, ppq_api_key: ppqKey,
      env_vars: [{ name: "FIXTURE_API_KEY", value: providerKey }, { name: "SUPERVISOR_TOKEN", value: "fixture-supervisor-not-forwarded" }],
      opencode_config: JSON.stringify({ model: "fixture/coding", provider: { legacy: {
        npm: "@ai-sdk/openai-compatible", name: "Legacy local provider",
        options: { baseURL: `http://127.0.0.1:${custom.address().port}/v1` },
        models: { coding: { id: "upstream/legacy-coder", tool_call: true,
          modalities: { input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } } },
      } }, providers: { fixture: {
        name: "Local test fixture", env: ["FIXTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${custom.address().port}/v1` },
        models: { coding: { modelID: "upstream/coder", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } } },
      } } }),
    }));
    const generated = spawnSync(process.execPath, [join(runtime, "managed-config.js"), "--options-file", input, "--environment-output", environment], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.ok(!generated.stdout.includes(providerKey));
    assert.ok(!(generated.stdout + generated.stderr).includes(ppqKey));
    const config = JSON.parse(generated.stdout);
    // Platform-only adaptation: keep the actual managed plugin implementations
    // while locating their package directories outside the Linux image.
    for (const plugin of config.plugins) {
      plugin.package = pathToFileURL(join(runtime, plugin.package.split("/").at(-1))).href;
      if (plugin.options?.files) plugin.options.files = [];
    }
    const configPath = join(root, "managed.json");
    await writeFile(configPath, JSON.stringify(config));
    const providerEnv = Object.fromEntries((await readFile(environment, "utf8")).split("\0").filter(Boolean).map((entry) => {
      const equals = entry.indexOf("=");
      return [entry.slice(0, equals), entry.slice(equals + 1)];
    }));
    assert.deepEqual(providerEnv, { FIXTURE_API_KEY: providerKey });
    const launch = () => {
      server = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
        cwd: join(root, "project"), stdio: ["ignore", "pipe", "pipe"],
        env: { ...providerEnv, PATH: process.env.PATH, HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_SERVER_PASSWORD: "fixture-password" },
      });
      for (const pipe of [server.stdout, server.stderr]) pipe.on("data", (chunk) => { logs += chunk; });
    };
    launch();
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` } });
    const waitReady = async () => {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const info = await client.server.info({ signal: AbortSignal.timeout(500) });
          assert.equal(info.version, JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).dependencies["@opencode/cli"]);
          ready = true; break;
        } catch { await sleep(50); }
      }
      assert.ok(ready, "isolated pinned V2 server did not become ready");
    };
    await waitReady();
    const run = async (model) => {
      const session = await client.session.create({ title: "provider fixture", ...(model ? { model } : {}) });
      await client.session.prompt({ sessionID: session.id, text: "Reply with the fixture response; no tools are needed." });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
    };
    await run(); // The generated raw model default selects the custom provider.
    assert.ok(requests.some((entry) => entry.route === "custom" && entry.path === "/v1/chat/completions" && entry.body.model === "upstream/coder" && entry.authorization === `Bearer ${providerKey}`));
    assert.equal(requests.some((entry) => entry.route === "ppq"), false);
    const location = { directory: join(root, "project") };
    const checkModelList = async () => {
      // This is the API consumed by /models and the post-/connect refresh. A
      // backend inference-only test misses response-encoding/schema failures.
      const catalog = await client.model.list({ location });
      Schema.decodeUnknownSync(Schema.Array(Model.Info))(catalog.data);
      const listed = catalog.data.filter((model) => model.providerID === "ppq-private");
      assert.equal(listed.length, 3);
      assert.deepEqual(listed.find((model) => model.id === "private/future-coder").cost,
        [{ input: 1.2, output: 3.4, cache: { read: 0.3, write: 1.8 } }]);
      assert.deepEqual(listed.find((model) => model.id === "private/no-cache-rates").cost,
        [{ input: 2, output: 4, cache: { read: 2, write: 2 } }]);
      assert.deepEqual(listed.find((model) => model.id === "private/unpriced").cost, []);
    };
    await checkModelList();
    await client.integration.connect.key({ integrationID: "ppq-private", location, key: "fixture-interactive-key-not-a-real-secret" });
    await checkModelList();
    await run({ providerID: "legacy", id: "coding" });
    assert.ok(requests.some((entry) => entry.route === "custom" && entry.path === "/v1/chat/completions" && entry.body.model === "upstream/legacy-coder"));
    await run({ providerID: "ppq-private", id: "private/future-coder" });
    assert.ok(requests.some((entry) => entry.route === "ppq" && entry.path === "https://api.ppq.ai/private/v1/chat/completions"
      && entry.body.model === "future-coder" && entry.privateModel === "private/future-coder" && entry.authorization === `Bearer ${ppqKey}`));
    const restartWithDefault = async (id) => {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
      config.model = `ppq-private/${id}`;
      config.plugins.find((plugin) => plugin.package.endsWith("/ppq-plugin")).options.defaultModel = id;
      await writeFile(configPath, JSON.stringify(config));
      launch();
      await waitReady();
      await client.session.create({ title: "Private default verification" });
      let selected;
      for (let attempt = 0; attempt < 100; attempt++) {
        selected = await client.model.default({ location });
        if (selected.data?.providerID === "ppq-private" && selected.data.id === id) return selected;
        await sleep(50); // Location registries initialize asynchronously after restart.
      }
      assert.fail("private default did not become available in the location registry");
    };
    const pricedDefault = await restartWithDefault("private/future-coder");
    assert.deepEqual(pricedDefault.data.cost[0].cache, { read: 0.3, write: 1.8 });
    Schema.decodeUnknownSync(Model.Info)(pricedDefault.data);
    await checkModelList();
    await run();
    // Retired private defaults must never select a public-provider fallback.
    const selected = await restartWithDefault("private/retired-default");
    assert.equal(selected.data.providerID, "ppq-private");
    assert.equal(selected.data.id, "private/retired-default");
    assert.match(selected.data.name, /Unavailable/);
    const before = requests.length;
    await run();
    assert.equal(requests.length, before, "retired private defaults cannot reach any inference transport");
    assert.ok(!logs.includes(providerKey), "provider API key must not appear in runtime logs");
    assert.ok(!logs.includes(ppqKey), "PPQ upstream key must not appear in runtime logs");
    assert.ok(!logs.includes("fixture-interactive-key-not-a-real-secret"));
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    for (const mock of [custom, ppq]) {
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
