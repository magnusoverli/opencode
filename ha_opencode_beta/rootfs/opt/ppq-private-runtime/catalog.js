// Public metadata only. Inference and credentials never pass through this client.
import { constants } from "node:fs";
import { open, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PPQ_MODELS_URL = "https://api.ppq.ai/v1/models";
export const TINFOIL_MODELS_URL = "https://inference.tinfoil.sh/v1/models";
export const CATALOG_TTL = 10 * 60_000;
export const MAX_STALE = 24 * 60 * 60_000;
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const isPrivateModel = (id) => typeof id === "string" && /^private\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
const integer = (value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
const price = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Complete the domain pricing contract, including old on-disk catalogs from
// 3.2.4b0. Unknown cache rates use ordinary input pricing, not a free discount.
export function normalizeCost(cost) {
  if (!cost || !price(cost.input) || !price(cost.output)
    || (cost.cache !== undefined && (!cost.cache || typeof cost.cache !== "object" || Array.isArray(cost.cache)
      || ["read", "write"].some((key) => cost.cache[key] !== undefined && !price(cost.cache[key]))))) {
    throw new Error("Invalid private model pricing");
  }
  return { input: cost.input, output: cost.output,
    cache: { read: cost.cache?.read ?? cost.input, write: cost.cache?.write ?? cost.input } };
}

export async function readJsonResponse(response) {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) throw new Error("Catalog unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_CATALOG_BYTES) throw new Error("Catalog too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function entries(document) {
  if (!document || !Array.isArray(document.data) || document.data.length > 2000) throw new Error("Invalid catalog");
  return document.data;
}

// Normalize to a bounded, inert format shared by the proxy, cache and V2 plugin.
// Never propagate catalog-supplied URLs, headers, request bodies or package names.
export function normalizeCatalog(document, metadata = { data: [] }) {
  const details = new Map(entries(metadata).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  const seen = new Set();
  return entries(document).filter((m) => isPrivateModel(m?.id) && m.privacyLevel === "e2e" && m.type === "chat").map((m) => {
    if (seen.has(m.id)) throw new Error("Duplicate private model");
    seen.add(m.id);
    const extra = m.owned_by === "Tinfoil" ? details.get(m.id.slice(8)) : undefined;
    const parameters = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const inputs = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
    const tools = parameters.includes("tools") || extra?.tool_calling === true;
    const image = inputs.includes("image") || extra?.multimodal === true;
    const context = integer(m.context_length) ? m.context_length : (integer(extra?.context_window) ? extra.context_window : 32768);
    const name = typeof m.name === "string" && m.name.length <= 200 && !/[\x00-\x1f]/.test(m.name)
      ? m.name.replace(/\s*\(Private(?: via TEE)?\)\s*$/, "") : m.id.slice(8);
    return {
      id: m.id, object: "model", type: "chat", owned_by: "ppq-private", privacyLevel: "e2e",
      name: `PPQ ${name} (Private)`, context_length: context,
      capabilities: { tools, input: image ? ["text", "image"] : ["text"], output: ["text"] },
      ...(price(m.pricing?.input_per_1M_tokens) && price(m.pricing?.output_per_1M_tokens) ? {
        cost: normalizeCost({ input: m.pricing.input_per_1M_tokens, output: m.pricing.output_per_1M_tokens,
          cache: {
            ...(price(m.pricing.cache_read_per_1M_tokens) ? { read: m.pricing.cache_read_per_1M_tokens } : {}),
            ...(price(m.pricing.cache_write_per_1M_tokens) ? { write: m.pricing.cache_write_per_1M_tokens } : {}),
          },
        }),
      } : {}),
    };
  });
}

export function validateModels(models) {
  if (!Array.isArray(models) || models.length > 100) throw new Error("Invalid private catalog");
  const seen = new Set();
  for (const m of models) {
    if (!isPrivateModel(m?.id) || seen.has(m.id) || m.privacyLevel !== "e2e" || m.type !== "chat"
      || typeof m.name !== "string" || !m.name.startsWith("PPQ ") || m.name.length > 240 || /[\x00-\x1f]/.test(m.name)
      || !integer(m.context_length) || typeof m.capabilities?.tools !== "boolean"
      || ![JSON.stringify(["text"]), JSON.stringify(["text", "image"])].includes(JSON.stringify(m.capabilities.input))
      || JSON.stringify(m.capabilities.output) !== JSON.stringify(["text"])) throw new Error("Invalid private model metadata");
    seen.add(m.id);
    if (m.cost !== undefined) normalizeCost(m.cost);
  }
  // Strip unknown properties even from a tampered cache or local response.
  return models.map((m) => ({ id: m.id, object: "model", type: "chat", owned_by: "ppq-private", privacyLevel: "e2e",
    name: m.name, context_length: m.context_length,
    capabilities: { tools: m.capabilities.tools, input: [...m.capabilities.input], output: ["text"] },
    ...(m.cost ? { cost: normalizeCost(m.cost) } : {}),
  }));
}

async function readCache(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return;
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CATALOG_BYTES) return;
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return { fetchedAt: data.fetchedAt, models: validateModels(data.models) };
  } catch { /* Missing, corrupt or unsafe caches are never a model source. */ }
  finally { await handle?.close(); }
}

export function createCatalog({ fetcher = fetch, now = Date.now, cacheFile, warn = () => {} } = {}) {
  let current;
  let loaded = false;
  let pending;
  let retryAt = 0;
  const usable = () => current && Number.isFinite(current.fetchedAt) && current.fetchedAt <= now()
    && now() - current.fetchedAt <= MAX_STALE;
  const publicJson = async (url) => readJsonResponse(await fetcher(url, {
    headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000),
  }));
  async function refresh() {
    if (!loaded) { loaded = true; if (cacheFile) current = await readCache(cacheFile); }
    if (usable() && now() - current.fetchedAt < CATALOG_TTL) return current.models;
    if (now() < retryAt) {
      if (usable()) return current.models;
      throw new Error("PPQ private model catalog unavailable; retry shortly");
    }
    try {
      const document = await publicJson(PPQ_MODELS_URL);
      // Optional capability enrichment must not turn a Tinfoil-only model into
      // a PPQ model or gate PPQ availability on a second public metadata service.
      let metadata = { data: [] };
      try {
        const candidate = await publicJson(TINFOIL_MODELS_URL);
        entries(candidate);
        metadata = candidate;
      }
      catch { warn("PPQ capability metadata unavailable; using conservative text/tool defaults."); }
      const models = validateModels(normalizeCatalog(document, metadata));
      current = { fetchedAt: now(), models };
      if (cacheFile) {
        const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
          await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
          await writeFile(temporary, JSON.stringify(current), { mode: 0o600, flag: "wx" });
          await rename(temporary, cacheFile);
        } catch { warn("PPQ model cache could not be saved; live discovery remains active."); }
        finally { await unlink(temporary).catch(() => {}); }
      }
      return models;
    } catch {
      retryAt = now() + 30_000;
      if (usable()) { warn("PPQ catalog refresh failed; using a cached private catalog (at most 24 hours old)."); return current.models; }
      throw new Error("PPQ private model catalog unavailable; no fresh cache exists");
    }
  }
  return { get() { pending ??= refresh().finally(() => { pending = undefined; }); return pending; } };
}
