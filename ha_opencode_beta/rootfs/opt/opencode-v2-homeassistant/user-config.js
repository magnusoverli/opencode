// Bounded native V2 configuration, based on /v2/docs/config, /providers and
// /models. Do not fall back to the public (potentially V1) config.json schema.
// Unsupported fields fail visibly instead of silently bypassing managed policy.
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { extractLegacyExternalMcpConfig, prepareExternalMcpConfig } from "./external-mcp.js";
import { isPrivateModel } from "../ppq-private-runtime/catalog.js";

// These are locked dependencies of the pinned plugin package already shipped in
// the image. The actual V2 decoder validates nested fields, not a V1 facsimile.
const decodeConfig = Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" });
const ROOT_FIELDS = ["$schema", "model", "default_agent", "providers", "formatter", "compaction", "media", "tool_output", "websearch", "plugins"];
const PACKAGES = new Set([
  "openai", "openai/chat", "openai/responses", "openai-compatible",
  "openai-compatible/responses", "anthropic", "anthropic-compatible", "google",
  "google-vertex", "google-vertex/gemini", "google-vertex/chat", "google-vertex/responses",
  "google-vertex/messages", "azure", "azure/chat", "azure/responses", "amazon-bedrock",
  "amazon-bedrock/mantle", "amazon-bedrock/mantle/chat", "amazon-bedrock/mantle/responses",
  "openrouter", "xai",
].map((name) => `@opencode/ai/providers/${name}`));

// No inherited environment is copied. In particular, never forward HA, PPQ,
// Supervisor, launcher/config, loader, or policy variables to the model server.
// API-key names cover custom providers; cloud chains and generic process knobs
// require separate qualification and deliberately remain unsupported here.
export function isProviderEnvironmentName(name) {
  return typeof name === "string"
    && /^[A-Z][A-Z0-9_]*_API_KEY$/.test(name)
    && !/^(?:OPENCODE|SUPERVISOR|HA|HAB|PPQ|NODE|BUN|LD)_/.test(name);
}

function invalid(message) {
  // Never include raw values, unknown keys, parse exceptions, or credentials.
  throw new TypeError(`opencode_config: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
}

function fields(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(`${label} contains unsupported fields; supported: ${allowed.join(", ")}`);
  }
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) invalid(`${label} must be a nonempty string without control characters`);
}

function jsonValues(value, environment, depth = 0) {
  if (depth > 32) invalid("nesting exceeds the supported limit");
  if (typeof value === "string") {
    if (value.includes("{file:")) invalid("file substitutions are not supported; use provider API keys in env_vars");
    for (const match of value.matchAll(/\{env:([^}]*)\}/g)) {
      if (!isProviderEnvironmentName(match[1])) invalid("environment substitutions require a supported provider *_API_KEY variable");
      if (!environment.has(match[1]) || !environment.get(match[1]).trim()) invalid("a referenced provider API key is missing; set its env_vars value and restart");
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => jsonValues(item, environment, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalid("unsafe object key");
      // Config substitution also runs on JSON keys in some runtime versions.
      if (key.includes("{env:") || key.includes("{file:")) invalid("substitutions in object keys are not supported");
      jsonValues(item, environment, depth + 1);
    }
  }
}

function requestOptions(value) {
  if (value.headers && Object.values(value.headers).some((header) => typeof header !== "string" || /[\r\n]/.test(header))) {
    invalid("headers must contain single-line string values");
  }
  if (value.settings?.baseURL !== undefined) {
    try {
      const url = new URL(value.settings.baseURL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    } catch { invalid("settings.baseURL must be an absolute HTTP(S) URL without credentials or a fragment"); }
  }
  if (value.settings?.apiKey !== undefined) text(value.settings.apiKey, "settings.apiKey");
  if (value.package !== undefined && !PACKAGES.has(value.package)) invalid("provider/model package must be a documented built-in @opencode/ai/providers runtime; external packages are not supported");
}

// Convert only the legacy provider shapes whose meaning is unambiguous here.
// The converted document still goes through the native schema and every managed
// policy check below. Never load an npm package from a legacy configuration.
function legacyRequest(options) {
  if (options === undefined) return {};
  object(options, "legacy provider/model options");
  const { headers, body, ...settings } = options;
  return {
    settings,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

function legacyModel(model) {
  fields(model, ["id", "name", "family", "limit", "cost", "tool_call", "modalities", "options", "headers", "variants"], "legacy provider model (convert unsupported fields to native V2 explicitly)");
  const { id, tool_call, modalities, options, variants, cost, headers, ...result } = model;
  Object.assign(result, legacyRequest(options));
  if (id !== undefined) result.modelID = id;
  if (headers !== undefined) {
    if (result.headers !== undefined) invalid("legacy model headers must be specified in only one place");
    result.headers = headers;
  }
  if (tool_call !== undefined || modalities !== undefined) {
    if (modalities !== undefined) fields(modalities, ["input", "output"], "legacy model modalities");
    result.capabilities = { ...modalities, ...(tool_call === undefined ? {} : { tools: tool_call }) };
  }
  if (cost !== undefined) {
    fields(cost, ["input", "output", "cache_read", "cache_write"], "legacy model cost");
    const { cache_read, cache_write, ...pricing } = cost;
    result.cost = { ...pricing, ...(cache_read === undefined && cache_write === undefined ? {} : {
      cache: { ...(cache_read === undefined ? {} : { read: cache_read }), ...(cache_write === undefined ? {} : { write: cache_write }) },
    }) };
  }
  if (variants !== undefined) {
    object(variants, "legacy model variants");
    result.variants = Object.entries(variants).map(([id, settings]) => {
      object(settings, "legacy model variant");
      if (Object.hasOwn(settings, "disabled")) invalid("legacy variant disabled flags require explicit native conversion");
      return { id, ...legacyRequest(settings) };
    });
  }
  return result;
}

function normalizeLegacyProviders(config, warn) {
  if (config.provider === undefined) return;
  object(config.provider, "legacy provider map");
  if (config.providers !== undefined) object(config.providers, "providers");
  const converted = Object.fromEntries(Object.entries(config.provider).map(([id, provider]) => {
    if (Object.hasOwn(config.providers ?? {}, id)) invalid("a provider is defined in both provider and providers; keep only one definition");
    fields(provider, ["name", "env", "npm", "api", "options", "models"], "legacy provider (convert unsupported fields to native V2 explicitly)");
    const { npm, api, options, models, ...result } = provider;
    Object.assign(result, legacyRequest(options));
    if (npm !== undefined) {
      if (npm !== "@ai-sdk/openai-compatible") invalid("automatic legacy npm conversion supports @ai-sdk/openai-compatible only; select a supported native package explicitly");
      result.package = "@opencode/ai/providers/openai-compatible";
    }
    if (api !== undefined) {
      if (result.settings?.baseURL !== undefined && result.settings.baseURL !== api) invalid("legacy api and options.baseURL disagree; keep one endpoint");
      result.settings = { ...result.settings, baseURL: api };
    }
    if (models !== undefined) {
      object(models, "legacy provider models");
      result.models = Object.fromEntries(Object.entries(models).map(([key, value]) => [key, legacyModel(value)]));
    }
    return [id, result];
  }));
  config.providers = { ...converted, ...config.providers };
  delete config.provider;
  warn("Legacy provider configuration was converted to native V2 in memory; saved options are unchanged. Unsupported legacy fields still require explicit conversion.");
}

export function ppqProvider() {
  return {
    name: "PPQ Private (TEE)",
    package: "@opencode/ai/providers/openai-compatible",
    // The upstream key belongs exclusively to the proxy, not the model server.
    settings: { apiKey: "unused", baseURL: "http://127.0.0.1:8787/v1", timeout: 600000, chunkTimeout: 60000 },
    // The bundled provider plugin discovers models from the private-only proxy.
    models: {},
  };
}

export function prepareUserConfig(options = {}, { warn = () => {} } = {}) {
  object(options, "add-on options");
  const environment = new Map();
  let unsupportedEnvironment = false;
  if (options.env_vars !== undefined && !Array.isArray(options.env_vars)) invalid("env_vars must be an array");
  for (const entry of options.env_vars ?? []) {
    if (!entry || typeof entry.name !== "string" || typeof entry.value !== "string" || entry.value.includes("\0")) invalid("env_vars entries require string names and values without NUL characters");
    if (isProviderEnvironmentName(entry.name)) {
      if (/[\r\n]/.test(entry.value) || /\{(?:file|env):/.test(entry.value)) invalid("provider API keys must be single-line literal values, not substitutions");
      environment.set(entry.name, entry.value);
    }
    else if (entry.name !== "PPQ_API_KEY") unsupportedEnvironment = true;
  }
  if (unsupportedEnvironment) warn("Some env_vars are not forwarded to the V2 backend: only non-reserved provider *_API_KEY variables are supported. Existing shell/service handling is separate.");

  let raw = options.opencode_config ?? "";
  if (typeof raw !== "string") invalid("the saved option must be a JSON string");
  if (Buffer.byteLength(raw) > 1024 * 1024) invalid("the saved option exceeds 1 MiB");
  let config = {};
  if (raw.trim()) {
    try { config = JSON.parse(raw); } catch { invalid("invalid JSON; correct the saved option and restart (JSONC is not supported here)"); }
  }
  object(config, "root");
  // Drop before validation so disabling the option also recovers from malformed
  // plugin entries. The parsed copy is separate from the saved add-on options.
  if (Object.hasOwn(config, "plugins") && options.custom_plugins_enabled !== true) {
    delete config.plugins;
    warn("Custom plugins entries were ignored because custom_plugins_enabled is off; saved options are unchanged.");
  }
  const legacyExternalMcp = extractLegacyExternalMcpConfig(config);
  fields(config, [...ROOT_FIELDS, "provider"], "root (direct permissions, agents, runtime and integration policy overrides are unsupported)");
  // Opted-in plugins are trusted code. Their options and substitutions belong
  // to upstream, not the add-on's provider credential/configuration policy.
  const { plugins: _plugins, ...nonPluginConfig } = config;
  jsonValues(nonPluginConfig, environment);
  normalizeLegacyProviders(config, warn);
  try { decodeConfig(config); }
  catch { invalid("native V2 schema validation failed; check field names and value types against /v2/docs/config and /v2/docs/providers (use npm/options only inside a supported legacy provider entry)"); }
  if (config.plugins?.length) warn("Third-party plugins are enabled as trusted root-level backend code; upstream handles loading and compatibility is not verified by the add-on.");
  if (config.$schema !== undefined && config.$schema !== "https://opencode.ai/config.json") invalid("$schema must be https://opencode.ai/config.json");
  if (config.model !== undefined && (typeof config.model !== "string" || !/^[^\s/#]+\/[^\s#]+$/.test(config.model))) invalid("model must be a provider/model string without a variant");
  if (config.default_agent !== undefined && !["build", "plan", "home-assistant-read-only"].includes(config.default_agent)) invalid("default_agent must be build, plan, or home-assistant-read-only");
  if (config.formatter !== undefined && typeof config.formatter !== "boolean") invalid("only boolean formatter overrides are currently supported");
  // This config field accepts the search providers shipped in the image.
  // Opting into plugin code does not relax unrelated configuration fields.
  if (config.websearch && !["exa", "firecrawl", "parallel", "tavily", "random"].includes(config.websearch.provider)) {
    invalid("websearch.provider must be exa, firecrawl, parallel, tavily or random; use websearch: false to disable search");
  }
  if (config.providers !== undefined) {
    object(config.providers, "providers");
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) invalid("provider IDs must use letters, digits, dots, underscores or hyphens");
      if (id === "ppq-private") invalid("ppq-private is managed; use the PPQ options instead of overriding its routing");
      if (provider.env !== undefined) {
        if (provider.env.some((name) => !isProviderEnvironmentName(name))) invalid("provider env accepts only non-reserved *_API_KEY variable names");
        if (provider.env.length && !provider.env.some((name) => environment.get(name)?.trim()) && !provider.settings?.apiKey) {
          warn("A provider's env credential is missing: set its *_API_KEY in env_vars or connect a provider account in V2. No account availability was checked.");
        }
      }
      requestOptions(provider);
      if (provider.models !== undefined) {
        object(provider.models, "provider models");
        for (const [id, entry] of Object.entries(provider.models)) {
          if (!id || /[\s#]/.test(id)) invalid("model IDs must be nonempty without whitespace or #");
          requestOptions(entry);
          if (entry.limit && Object.values(entry.limit).some((n) => !Number.isSafeInteger(n) || n <= 0)) invalid("model limits must be positive integers");
          const variants = new Set();
          for (const variant of entry.variants ?? []) {
            if (variants.has(variant.id)) invalid("variant IDs must be unique");
            variants.add(variant.id);
            requestOptions(variant);
          }
        }
      }
    }
  }

  const ppqEnabled = options.ppq_private_enabled === true;
  const ppqKey = options.ppq_api_key || [...(options.env_vars ?? [])].reverse().find((entry) => entry.name === "PPQ_API_KEY")?.value;
  if (ppqEnabled && typeof ppqKey === "string" && ppqKey.trim()) {
    config.providers = { ...config.providers, "ppq-private": ppqProvider() };
    warn("PPQ private models are discovered through the local encrypted proxy; select a PPQ model explicitly. Proxy readiness and upstream inference are not verified at startup.");
  } else if (ppqEnabled) {
    warn("PPQ private mode has no API key; its managed provider is inactive. Set ppq_api_key or PPQ_API_KEY in env_vars and restart.");
  }
  if (config.model?.startsWith("ppq-private/") && !config.providers?.["ppq-private"]) invalid("the selected PPQ model needs private mode enabled and a PPQ API key");
  if (config.model?.startsWith("ppq-private/") && !isPrivateModel(config.model.slice("ppq-private/".length))) invalid("the selected PPQ model must use a private/* model ID; availability is discovered at runtime");

  const providerEnvironment = Buffer.from([...environment].map(([name, value]) => `${name}=${value}\0`).join(""));
  if (providerEnvironment.length > 65536) invalid("provider environment exceeds 64 KiB");
  return { config, providerEnvironment, externalMcp: prepareExternalMcpConfig(options, legacyExternalMcp) };
}
