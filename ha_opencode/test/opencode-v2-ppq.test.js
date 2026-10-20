import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createCatalog, normalizeCatalog, validateModels, readJsonResponse, CATALOG_TTL, MAX_STALE, MAX_CATALOG_BYTES,
  PPQ_MODELS_URL, TINFOIL_MODELS_URL } from "../rootfs/opt/ppq-private-runtime/catalog.js";
import { createProxy } from "../rootfs/opt/ppq-private-runtime/proxy.js";
import { createPpqSetup } from "../rootfs/opt/opencode-v2-homeassistant/ppq.js";

const raw = (id = "future-coder") => ({ id: `private/${id}`, name: "Future Coder (Private via TEE)", type: "chat",
  privacyLevel: "e2e", owned_by: "Tinfoil", context_length: 65536,
  pricing: { input_per_1M_tokens: 1.2, output_per_1M_tokens: 3.4 } });
const document = (...models) => ({ object: "list", data: models });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("pinned encrypted transport imports with the standalone production dependency tree", async () => {
  const { SecureClient } = await import("../rootfs/opt/ppq-private-runtime/node_modules/tinfoil/dist/index.js");
  assert.equal(typeof SecureClient, "function");
});

test("live private catalog discovers new IDs, excludes non-private models and imports inert capabilities/prices", () => {
  const models = normalizeCatalog(document(raw(), { ...raw("plain"), id: "vendor/plain" }, { ...raw("unsafe"), privacyLevel: "zdr" },
    { ...raw("embedding"), type: "embedding" }, { ...raw("../../evil"), package: "evil" }),
  document({ id: "future-coder", tool_calling: true, multimodal: true }, { id: "not-on-ppq", tool_calling: true }));
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "private/future-coder");
  assert.equal(models[0].name, "PPQ Future Coder (Private)");
  assert.deepEqual(models[0].capabilities, { tools: true, input: ["text", "image"], output: ["text"] });
  assert.deepEqual(models[0].cost, { input: 1.2, output: 3.4 });
  assert.deepEqual(validateModels(models), models);
  assert.deepEqual(validateModels([{ ...models[0], settings: { baseURL: "https://evil.invalid" }, package: "evil" }]), models);
  assert.throws(() => normalizeCatalog(document(raw(), raw())), /Duplicate/);
  assert.throws(() => normalizeCatalog({ models: [] }), /Invalid/);
  assert.throws(() => validateModels([{ ...models[0], id: "vendor/plain" }]), /Invalid/);
  const conservative = normalizeCatalog(document({ ...raw(), context_length: -1, pricing: { input_per_1M_tokens: -1 } }))[0];
  assert.deepEqual(conservative.capabilities, { tools: false, input: ["text"], output: ["text"] });
  assert.equal(conservative.context_length, 32768);
  assert.equal(conservative.cost, undefined);
});

test("catalog responses bound advertised and streamed sizes", async () => {
  await assert.rejects(readJsonResponse(new Response("{}", { headers: { "Content-Length": String(MAX_CATALOG_BYTES + 1) } })));
  await assert.rejects(readJsonResponse(new Response(" ".repeat(MAX_CATALOG_BYTES + 1))));
  await assert.rejects(readJsonResponse(response({}, 503)));
});

test("catalog refresh shares requests, removes retired IDs and persists bounded offline fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-ppq-catalog-"));
  try {
    const cacheFile = join(root, "models.json");
    let clock = 1_000_000;
    let models = [raw("old-model")];
    let offline = false;
    const calls = [];
    const warnings = [];
    const fetcher = async (url, options) => {
      calls.push({ url, options });
      if (offline) throw new Error("credential-like-value-must-not-be-logged");
      return response(url === PPQ_MODELS_URL ? document(...models) : document({ id: models[0]?.id.slice(8), tool_calling: true }));
    };
    const options = { cacheFile, now: () => clock, fetcher, warn: (m) => warnings.push(m) };
    const catalog = createCatalog(options);
    await Promise.all([catalog.get(), catalog.get(), catalog.get()]);
    assert.deepEqual(calls.map((c) => c.url), [PPQ_MODELS_URL, TINFOIL_MODELS_URL]);
    for (const { options: request } of calls) {
      assert.deepEqual(request.headers, { Accept: "application/json" });
      assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error");
    }
    assert.equal((await catalog.get())[0].id, "private/old-model");
    assert.equal(calls.length, 2);
    models = [raw("new-model")];
    clock += CATALOG_TTL + 1;
    assert.deepEqual((await catalog.get()).map((m) => m.id), ["private/new-model"]);
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.equal(cache.models[0].id, "private/new-model");
    offline = true;
    clock += CATALOG_TTL + 1;
    assert.equal((await createCatalog(options).get())[0].id, "private/new-model");
    assert.match(warnings.join("\n"), /cached private catalog/);
    assert.doesNotMatch(warnings.join("\n"), /credential-like/);
    clock += MAX_STALE;
    await assert.rejects(createCatalog(options).get(), /no fresh cache/);
    await writeFile(cacheFile, "invalid");
    await assert.rejects(createCatalog(options).get(), /no fresh cache/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capability-service outages cannot add models or prevent live PPQ discovery; empty catalogs remove everything", async () => {
  let clock = 1_000_000;
  let empty = false;
  const catalog = createCatalog({ now: () => clock, fetcher: async (url) => {
    if (url === TINFOIL_MODELS_URL) throw new Error("unavailable");
    return response(document(...(empty ? [] : [raw()])));
  } });
  assert.equal((await catalog.get())[0].capabilities.tools, false);
  empty = true;
  clock += CATALOG_TTL + 1;
  assert.deepEqual(await catalog.get(), []);
  const failing = createCatalog({ fetcher: async () => { throw new Error("offline"); } });
  await assert.rejects(failing.get(), /no fresh cache/);
  await assert.rejects(failing.get(), /retry shortly/);
});

test("V2 discovery replaces models on reload, clears unavailable inventory and recovers without a restart", async () => {
  let current = normalizeCatalog(document({ ...raw(), supported_parameters: ["tools"] }));
  let callback;
  let timer;
  let unavailable = false;
  let disposed = false;
  let selected;
  let reloads = 0;
  const apply = () => callback({ models: { set(provider, models) { assert.equal(provider, "ppq-private"); selected = models; } } });
  const cleanup = await createPpqSetup({
    fetcher: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8787/v1/models");
      assert.equal(options.headers.Authorization, undefined);
      return response(document(...current), unavailable ? 503 : 200);
    },
    schedule(fn) { timer = fn; return 123; }, unschedule(id) { assert.equal(id, 123); }, warn() {},
  })({ provider: {
    async transform(fn) { callback = fn; apply(); return { async dispose() { disposed = true; } }; },
    async reload() { reloads++; apply(); },
  } });
  assert.equal(selected[0].id, "private/future-coder");
  assert.equal(selected[0].name, "PPQ Future Coder (Private)");
  assert.equal(selected[0].capabilities.tools, true);
  assert.deepEqual(selected[0].cost, [{ input: 1.2, output: 3.4 }]);
  current = normalizeCatalog(document(raw("next-coder")));
  await timer();
  assert.deepEqual(selected.map((m) => m.id), ["private/next-coder"]);
  unavailable = true;
  await timer();
  assert.deepEqual(selected, []);
  unavailable = false;
  await timer();
  assert.equal(selected[0].id, "private/next-coder");
  assert.equal(reloads, 4);
  await cleanup();
  assert.equal(disposed, true);
});

test("retired or offline explicit PPQ defaults stay private instead of falling back to another provider", async () => {
  let source;
  let tick;
  let offline = false;
  const apply = () => source({ models: { set(_provider, models) {
    const requested = models.find((m) => m.id === "private/retired-default");
    assert.ok(requested);
    assert.equal(requested.providerID, "ppq-private");
    assert.equal(requested.enabled, true, "the explicit default must remain resolvable to prevent upstream fallback");
    assert.match(requested.name, /Unavailable/);
  } } });
  const cleanup = await createPpqSetup({
    fetcher: async () => response(document(...normalizeCatalog(document(raw()))), offline ? 503 : 200),
    schedule(fn) { tick = fn; return 1; }, unschedule() {}, warn() {},
  })({ options: { defaultModel: "private/retired-default" }, provider: {
    async transform(fn) { source = fn; apply(); return { async dispose() {} }; }, async reload() { apply(); },
  } });
  offline = true;
  await tick();
  await cleanup();
});

test("private proxy validates live models, attests before encryption, streams and never falls back to plaintext", async () => {
  let models = normalizeCatalog(document(raw()));
  let catalogDown = false;
  const calls = [];
  const logs = [];
  const proxy = createProxy({ apiKey: "private-upstream-key", catalog: { async get() {
    if (catalogDown) throw new Error("catalog unavailable");
    return models;
  } }, secureClient: {
    async ready() { calls.push("attest"); },
    async fetch(url, options) { calls.push({ url, options }); return new Response("data: fixture\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }); },
  }, log: (m) => logs.push(m) });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const send = (model, extra = {}, headers = {}) => fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer unused", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "private-prompt" }], tools: [], tool_choice: "auto", stream: true, ...extra }),
  });
  try {
    assert.equal((await (await fetch(`${base}/v1/models`)).json()).data[0].id, "private/future-coder");
    assert.deepEqual(calls, [], "catalog discovery must not require an attestation or inference call");
    assert.equal((await send("private/retired-model")).status, 400);
    assert.equal((await send("vendor/plain")).status, 400);
    assert.equal((await send("private/future-coder", {}, { Origin: "https://hostile.invalid" })).status, 403);
    const rebound = await new Promise((resolve, reject) => {
      const req = request(`${base}/v1/models`, { headers: { Host: "hostile.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(rebound, 403);
    assert.equal((await send("private/future-coder", {}, { "Content-Type": "text/plain" })).status, 415);
    assert.deepEqual(calls, []);
    const result = await send("private/future-coder");
    assert.equal(result.status, 200);
    assert.match(await result.text(), /data: \[DONE\]/);
    assert.equal(calls[0], "attest");
    const { url, options } = calls[1];
    assert.equal(url, "https://api.ppq.ai/private/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer private-upstream-key");
    assert.equal(options.headers["X-Private-Model"], "private/future-coder");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "future-coder");
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    models = [];
    assert.equal((await send("private/future-coder")).status, 400);
    assert.equal(calls.length, 2);
    catalogDown = true;
    assert.equal((await fetch(`${base}/v1/models`)).status, 503);
  } finally { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }

  let retryReady = false;
  const failed = createProxy({ apiKey: "private-upstream-key", catalog: { get: async () => normalizeCatalog(document(raw())) },
    secureClient: { async ready() { if (!retryReady) throw new Error("secret-sdk-error"); }, reset() { retryReady = true; },
      async fetch() { assert.ok(retryReady, "must not send after failed attestation"); return new Response("recovered"); } },
    log: (m) => logs.push(m) });
  await new Promise((resolve) => failed.listen(0, "127.0.0.1", resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${failed.address().port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "private/future-coder" }),
    });
    assert.equal(result.status, 502);
    assert.match(await result.text(), /No unencrypted fallback/);
    assert.doesNotMatch(logs.join("\n"), /secret-sdk-error|private-upstream-key|private-prompt/);
    const retry = await fetch(`http://127.0.0.1:${failed.address().port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "private/future-coder" }),
    });
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), "recovered");
  } finally { failed.closeAllConnections(); await new Promise((resolve) => failed.close(resolve)); }
});
