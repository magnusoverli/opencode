#!/usr/local/bin/node
// Image-owned, private-only HTTP adapter. Cryptography and attestation remain
// entirely in the pinned Tinfoil SDK; there is deliberately no plaintext fallback.
import http from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createCatalog, isPrivateModel } from "./catalog.js";

const API_BASE = "https://api.ppq.ai";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export function createProxy({ apiKey, catalog, secureClient, log = () => {} }) {
  let ready;
  const attest = () => {
    ready ??= Promise.resolve().then(() => secureClient.ready()).catch(() => {
      ready = undefined;
      secureClient.reset?.(); // The SDK caches failed initialization until reset.
      throw new Error("Private enclave attestation failed");
    });
    return ready;
  };
  return http.createServer(async (req, res) => {
    // Loopback is not browser authentication. Reject cross-site requests and
    // DNS rebinding; never emit permissive CORS headers or accept form POSTs.
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host ?? "") || req.headers.origin) {
      json(res, 403, { error: { message: "PPQ proxy accepts local non-browser clients only" } }); return;
    }
    const path = req.url?.split("?")[0];
    if (req.method === "GET" && path === "/health") {
      json(res, 200, { status: "ok" }); return; // Liveness, not attestation evidence.
    }
    if (req.method === "GET" && path === "/v1/models") {
      try { json(res, 200, { object: "list", data: await catalog.get() }); }
      catch { json(res, 503, { error: { message: "PPQ private catalog unavailable; retry shortly" } }); }
      return;
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      json(res, 404, { error: { message: "Unknown private proxy endpoint" } }); return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      json(res, 415, { error: { message: "Content-Type must be application/json" } }); return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) { json(res, 413, { error: { message: "Private request too large" } }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { json(res, 400, { error: { message: "Invalid JSON request" } }); return; }
      if (!body || Array.isArray(body) || !isPrivateModel(body.model)) {
        json(res, 400, { error: { message: "Select a private/* model from /v1/models; non-private routing is disabled" } }); return;
      }
      const models = await catalog.get();
      if (!models.some((model) => model.id === body.model)) {
        json(res, 400, { error: { message: "Selected private model is no longer available; select a current PPQ model from /models" } }); return;
      }
      const model = body.model;
      body.model = model.slice(8);
      // Tinfoil rejects empty tools arrays emitted by some agent clients.
      if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools;
      if (body.tools === undefined) delete body.tool_choice;
      await attest();
      const response = await secureClient.fetch(`${API_BASE}/private/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`,
          "X-Private-Model": model, "x-query-source": "api" },
        body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)]),
      });
      res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
      if (response.body) {
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
        }
      }
      res.end();
    } catch {
      // SDK/network exceptions may contain credentials, prompts or response data.
      log("PPQ encrypted request failed; check catalog availability, enclave attestation and account status.");
      if (!res.headersSent) json(res, 502, { error: { message: "PPQ private request failed; check proxy logs and account status. No unencrypted fallback was attempted." } });
      else res.destroy();
    }
  });
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  if (!process.env.PPQ_API_KEY) throw new Error("PPQ_API_KEY is required");
  const { SecureClient } = await import("tinfoil");
  const catalog = createCatalog({ cacheFile: "/data/.ppq-private/models.json", warn: console.warn });
  const secureClient = new SecureClient({ baseURL: `${API_BASE}/private/`, attestationBundleURL: `${API_BASE}/private`, transport: "ehbp" });
  const server = createProxy({ apiKey: process.env.PPQ_API_KEY, catalog, secureClient, log: console.warn });
  server.listen(8787, "127.0.0.1", () => console.info("PPQ private-only proxy listening on 127.0.0.1:8787; model discovery is live."));
}
