// Runs only in the native boundary-test image. Requests stay on loopback and
// credentials are synthetic. Assert outcomes without printing request headers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";

const [mode, root, serverPort] = process.argv.slice(2);
const key = "fixture-startup-provider-key";
const model = "fixture/upstream-coder";
const mockPort = 18766;
const optionsFile = join(root, "provider-options.json");

if (mode === "serve") {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return response.end("ok");
    if (request.method === "GET" && request.url === "/result") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(requests));
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      return response.writeHead(404).end();
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) return response.writeHead(413).end();
      }
      const body = JSON.parse(raw);
      requests.push({
        authenticated: request.headers.authorization === `Bearer ${key}`,
        modelMatches: body.model === model,
        readToolPresent: (body.tools ?? []).some((tool) => tool.function?.name === "read"),
        searchDisabled: !(body.tools ?? []).some((tool) => tool.function?.name === "websearch"),
      });
      if (!requests.at(-1).authenticated) return response.writeHead(401).end();
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "Startup fixture complete." }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "startup-fixture", object: "chat.completion.chunk", created: 1,
          model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(mockPort, "127.0.0.1", resolve));
  await writeFile(optionsFile, JSON.stringify({
    env_vars: [
      { name: "FIXTURE_API_KEY", value: key },
      { name: "SUPERVISOR_TOKEN", value: "fixture-never-forwarded" },
    ],
    opencode_config: JSON.stringify({
      model: "startup/coding", websearch: false,
      providers: { startup: {
        name: "Native startup fixture", env: ["FIXTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, timeout: 5000 },
        models: { coding: { modelID: model, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } } },
      } },
    }),
  }), { mode: 0o600 });
  await writeFile(join(root, "provider-fixture.ready"), "ready\n");
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else if (mode === "verify") {
  const password = (await readFile(join(root, "server-password"), "utf8")).trim();
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${serverPort}`,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
  const session = await client.session.create({ title: "Native provider startup fixture" }, { signal: AbortSignal.timeout(10000) });
  await client.session.prompt({ sessionID: session.id, text: "Reply briefly; no tools are needed." }, { signal: AbortSignal.timeout(10000) });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
  const result = await fetch(`http://127.0.0.1:${mockPort}/result`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json());
  assert.ok(result.length > 0, "the generated default model must reach the controlled provider");
  assert.ok(result.every((request) => request.authenticated && request.modelMatches && request.searchDisabled && request.readToolPresent),
    "native startup must retain the secured credential, selected model and disabled search policy");
  console.log("Native provider startup and disabled-search request passed");
} else {
  throw new Error("Expected serve or verify");
}
