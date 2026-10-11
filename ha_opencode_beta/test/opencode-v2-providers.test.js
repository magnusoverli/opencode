import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildManagedConfig, READ_ONLY_AGENT_ID } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { prepareUserConfig, isProviderEnvironmentName, ppqProvider } from "../rootfs/opt/opencode-v2-homeassistant/user-config.js";

const generator = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/managed-config.js", import.meta.url));
const fixtureKey = "fixture-key-$'`\\\"-never-log";
const nativeProvider = () => ({
  name: "Fixture", env: ["FIXTURE_API_KEY"],
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "http://127.0.0.1:12345/v1", timeout: 1000 },
  models: { coding: { modelID: "upstream/coder", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 8192, output: 1000 } } },
});
const options = (config, extra = {}) => ({
  opencode_config: JSON.stringify(config),
  env_vars: [{ name: "FIXTURE_API_KEY", value: fixtureKey }], ...extra,
});

describe("bounded native V2 provider configuration", () => {
  it("accepts the reported V1 local provider without changing saved options or managed policy", () => {
    const input = options({ provider: { "my-local": {
      npm: "@ai-sdk/openai-compatible", name: "My Local Stack",
      options: { baseURL: "http://192.0.2.50:1234/v1" },
      models: { "your-model-id": { name: "Your Model" } },
    } } });
    const original = structuredClone(input);
    const warnings = [];
    const result = prepareUserConfig(input, { warn: (message) => warnings.push(message) });
    assert.deepEqual(result.config, { providers: { "my-local": {
      package: "@opencode/ai/providers/openai-compatible", name: "My Local Stack",
      settings: { baseURL: "http://192.0.2.50:1234/v1" },
      models: { "your-model-id": { name: "Your Model" } },
    } } });
    assert.deepEqual(input, original);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /converted.*saved options are unchanged/);
    assert.doesNotMatch(warnings[0], /192\.0\.2|my-local|fixture-key/);
  });

  it("preserves legacy model aliases, limits, modalities, pricing, requests and variants", () => {
    const input = options({ model: "legacy/coding", provider: { legacy: {
      env: ["FIXTURE_API_KEY"], api: "https://fixture.test/v1",
      options: { apiKey: "{env:FIXTURE_API_KEY}", headers: { "X-Fixture": "one" }, body: { store: false } },
      models: { coding: { id: "upstream/model", name: "Coding", family: "fixture", tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 8192, output: 1024 },
        cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1.5 },
        options: { temperature: 0.2 }, headers: { "X-Model": "two" },
        variants: { low: { reasoningEffort: "low", body: { service_tier: "flex" } } },
      } },
    } }, providers: { fixture: nativeProvider() } });
    const { config } = prepareUserConfig(input);
    assert.equal(config.provider, undefined);
    assert.equal(config.model, "legacy/coding");
    assert.deepEqual(config.providers.fixture, nativeProvider());
    assert.deepEqual(config.providers.legacy, {
      env: ["FIXTURE_API_KEY"], settings: { apiKey: "{env:FIXTURE_API_KEY}", baseURL: "https://fixture.test/v1" },
      headers: { "X-Fixture": "one" }, body: { store: false },
      models: { coding: { modelID: "upstream/model", name: "Coding", family: "fixture",
        capabilities: { input: ["text", "image"], output: ["text"], tools: true }, limit: { context: 8192, output: 1024 },
        cost: { input: 1, output: 2, cache: { read: 0.5, write: 1.5 } },
        settings: { temperature: 0.2 }, headers: { "X-Model": "two" },
        variants: [{ id: "low", settings: { reasoningEffort: "low" }, body: { service_tier: "flex" } }],
      } },
    });
  });

  it("applies every native policy restriction after legacy provider conversion", () => {
    for (const provider of [
      { npm: "file:///tmp/private-package" },
      { npm: "@ai-sdk/anthropic" },
      { options: { apiKey: "{file:/run/opencode-v2/server-password}" } },
      { options: { apiKey: "{env:SUPERVISOR_TOKEN}" } },
      { env: ["HA_API_KEY"] },
      { options: { baseURL: "https://user:secret@example.invalid" } },
      { options: { headers: { Authorization: "first\r\nsecond" } } },
      { models: { coding: { limit: { context: -1 } } } },
      { models: { coding: { modalities: { input: [123] } } } },
      { models: { coding: { tool_call: "true" } } },
      { models: { coding: { variants: { hidden: { disabled: true } } } } },
      { models: { coding: { invented: fixtureKey } } },
      { api: "https://first.test", options: { baseURL: "https://second.test" } },
      { models: { coding: { headers: {}, options: { headers: {} } } } },
    ]) assert.throws(() => prepareUserConfig(options({ provider: { fixture: provider } })), (error) => {
      assert.match(error.message, /opencode_config:/);
      assert.doesNotMatch(error.message, /private-package|server-password|SUPERVISOR_TOKEN|example\.invalid|fixture-key/);
      return true;
    });
    assert.throws(() => prepareUserConfig(options({ provider: { fixture: {} }, providers: { fixture: {} } })), /both provider and providers/);
    assert.throws(() => prepareUserConfig(options({ provider: { "ppq-private": {} } })), /ppq-private is managed/);
    for (const raw of ['{"provider":{"__proto__":{}}}', '{"provider":{"fixture":{"options":{"constructor":{}}}}}']) {
      assert.throws(() => prepareUserConfig({ opencode_config: raw }), /unsafe object key/);
    }
    for (const policy of [{ plugins: ["-homeassistant.runtime-guard"] }, { agents: {} }, { permissions: [] }]) {
      assert.throws(() => prepareUserConfig(options({ provider: { fixture: {} }, ...policy })), /unsupported fields/);
    }
  });

  it("preserves native providers, aliases, overlays and variants using the pinned schema", () => {
    const provider = nativeProvider();
    provider.models.coding.variants = [{ id: "low", settings: { reasoningEffort: "low" }, body: { service_tier: "flex" } }];
    provider.models.coding.compatibility = { reasoningField: "reasoning_content" };
    provider.headers = { Authorization: "Bearer {env:FIXTURE_API_KEY}" };
    const config = { model: "fixture/coding", providers: { fixture: provider }, formatter: false, compaction: { auto: false } };
    const result = prepareUserConfig(options(config));
    assert.deepEqual(result.config, config);
    assert.equal(result.providerEnvironment.toString(), `FIXTURE_API_KEY=${fixtureKey}\0`);
    assert.ok(!JSON.stringify(result.config).includes(fixtureKey));
  });

  it("retains no stale providers or environment entries when options are cleared", () => {
    prepareUserConfig(options({ providers: { fixture: nativeProvider() } }));
    const empty = prepareUserConfig();
    assert.deepEqual(empty.config, {});
    assert.equal(empty.providerEnvironment.length, 0);
  });

  it("preserves native search selection and forwards each documented search key without embedding it in config", () => {
    for (const provider of ["exa", "firecrawl", "parallel", "tavily", "random"]) {
      const name = provider === "random" ? "TAVILY_API_KEY" : `${provider.toUpperCase()}_API_KEY`;
      const result = prepareUserConfig({
        opencode_config: JSON.stringify({ websearch: { provider } }),
        env_vars: [{ name, value: fixtureKey }],
      });
      assert.deepEqual(result.config.websearch, { provider });
      assert.equal(result.providerEnvironment.toString(), `${name}=${fixtureKey}\0`);
      assert.ok(!JSON.stringify(result.config).includes(fixtureKey));
      // Missing env keys must still permit the native account sign-in path.
      assert.deepEqual(prepareUserConfig({ opencode_config: JSON.stringify(result.config) }).config, result.config);
    }
    assert.deepEqual(prepareUserConfig(options({ websearch: false })).config, { websearch: false });
    assert.equal(prepareUserConfig().config.websearch, undefined);
  });

  it("uses last duplicate env value without shell evaluation and warns on unsupported backend variables", () => {
    const warnings = [];
    const prepared = prepareUserConfig({ env_vars: [
      { name: "FIXTURE_API_KEY", value: "old" }, { name: "FIXTURE_API_KEY", value: fixtureKey },
      { name: "HTTPS_PROXY", value: "sensitive-proxy-value" },
      { name: "OPENCODE_CONFIG_CONTENT", value: "sensitive-policy-value" },
      { name: "SUPERVISOR_TOKEN", value: "sensitive-token-value" },
    ] }, { warn: (message) => warnings.push(message) });
    assert.equal(prepared.providerEnvironment.toString(), `FIXTURE_API_KEY=${fixtureKey}\0`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not forwarded/);
    assert.doesNotMatch(warnings[0], /sensitive-|fixture-key/);
  });

  it("never forwards reserved policy or integration credentials", () => {
    for (const name of ["SUPERVISOR_API_KEY", "HA_API_KEY", "HAB_API_KEY", "PPQ_API_KEY", "OPENCODE_API_KEY", "NODE_API_KEY", "BUN_API_KEY", "LD_API_KEY", "NODE_OPTIONS", "BASH_ENV", "AWS_SECRET_ACCESS_KEY", "SUPERVISOR_TOKEN", "HA_ACCESS_TOKEN", "API_KEY", "bad\n_API_KEY"]) {
      assert.equal(isProviderEnvironmentName(name), false, name);
    }
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CUSTOM_2_API_KEY"]) {
      assert.equal(isProviderEnvironmentName(name), true, name);
    }
  });

  for (const [label, config] of [
    ["malformed legacy provider", { provider: { fixture: null } }],
    ["legacy provider npm", { providers: { fixture: { npm: "@ai-sdk/openai-compatible" } } }],
    ["legacy provider options", { providers: { fixture: { options: { apiKey: fixtureKey } } } }],
    ["malformed nested model", { providers: { fixture: { models: { coding: { limit: { output: "100" } } } } } }],
    ["malformed native control", { providers: { fixture: { settings: { timeout: "fast" } } } }],
    ["unknown nested model field", { providers: { fixture: { models: { coding: { invented: fixtureKey } } } } }],
    ["plugin disable", { plugins: ["-homeassistant.runtime-guard"] }],
    ["permission bypass", { permissions: [{ action: "*", resource: "*", effect: "allow" }] }],
    ["read-only agent override", { agents: { [READ_ONLY_AGENT_ID]: { permissions: [] } } }],
    ["runtime update", { update: "auto" }],
    ["unknown search provider", { websearch: { provider: "custom" } }],
    ["search without selection", { websearch: {} }],
    ["search true shorthand", { websearch: true }],
    ["search endpoint override", { websearch: { provider: "tavily", baseURL: "https://example.invalid" } }],
    ["search key in config", { websearch: { provider: "tavily", apiKey: fixtureKey } }],
    ["LSP enable", { lsp: true }],
    ["external provider code", { providers: { fixture: { package: "file:///tmp/plugin" } } }],
    ["external model code", { providers: { fixture: { models: { coding: { package: "evil-package" } } } } }],
    ["file expansion", { providers: { fixture: { settings: { apiKey: "{file:/run/opencode-v2/server-password}" } } } }],
    ["ambient credential expansion", { providers: { fixture: { settings: { apiKey: "{env:SUPERVISOR_TOKEN}" } } } }],
    ["managed PPQ route override", { providers: { "ppq-private": { settings: { baseURL: "https://example.invalid" } } } }],
    ["shell formatter", { formatter: { custom: { command: ["sh", "-c", "echo unsafe"] } } }],
    ["URL credentials", { providers: { fixture: { settings: { baseURL: "https://user:secret@example.invalid" } } } }],
    ["invalid header", { providers: { fixture: { headers: { Authorization: "first\r\nsecond" } } } }],
  ]) {
    it(`rejects ${label} without echoing supplied values`, () => {
      assert.throws(() => prepareUserConfig(options(config)), (error) => {
        assert.match(error.message, /opencode_config:/);
        assert.ok(!error.message.includes(fixtureKey));
        assert.doesNotMatch(error.message, /server-password|example\.invalid|evil-package/);
        return true;
      });
    });
  }

  it("requires explicit environment substitutions to exist but allows native account sign-in for env declarations", () => {
    const warnings = [];
    const config = { providers: { fixture: nativeProvider() } };
    prepareUserConfig(options(config, { env_vars: [] }), { warn: (message) => warnings.push(message) });
    assert.match(warnings.join("\n"), /credential is missing.*connect a provider account/);
    config.providers.fixture.settings.apiKey = "{env:FIXTURE_API_KEY}";
    assert.throws(() => prepareUserConfig(options(config, { env_vars: [] })), /referenced provider API key is missing/);
  });

  it("rejects secret-valued parser errors, prototype keys, recursive substitutions and excessive input", () => {
    for (const raw of [`{"${fixtureKey}`, "null", "[]", '{"providers":{"__proto__":{}}}', '{"providers":{"fixture":{"settings":{"constructor":{}}}}}']) {
      assert.throws(() => prepareUserConfig({ opencode_config: raw }), (error) => !error.message.includes(fixtureKey));
    }
    for (const value of ["a\0b", "a\nb", "{file:/secret}", "{env:SUPERVISOR_TOKEN}"]) {
      assert.throws(() => prepareUserConfig({ env_vars: [{ name: "FIXTURE_API_KEY", value }] }));
    }
    assert.throws(() => prepareUserConfig({ opencode_config: " ".repeat(1024 * 1024 + 1) }), /1 MiB/);
    assert.throws(() => prepareUserConfig({ env_vars: [{ name: "FIXTURE_API_KEY", value: "x".repeat(65536) }] }), /64 KiB/);
  });

  it("wires PPQ only with a key and never forwards its upstream credential", () => {
    for (const ppqOptions of [{ ppq_api_key: fixtureKey }, { env_vars: [{ name: "PPQ_API_KEY", value: fixtureKey }] }]) {
      const warnings = [];
      const result = prepareUserConfig({ ppq_private_enabled: true, ...ppqOptions }, { warn: (message) => warnings.push(message) });
      assert.deepEqual(result.config.providers["ppq-private"], ppqProvider());
      assert.equal(result.config.model, undefined, "enabling PPQ never silently changes the selected model");
      assert.equal(result.providerEnvironment.length, 0);
      assert.ok(!JSON.stringify(result.config).includes(fixtureKey));
      assert.ok(!warnings.join("\n").includes(fixtureKey));
      assert.match(warnings.join("\n"), /readiness.*not verified/);
    }
    const warnings = [];
    assert.deepEqual(prepareUserConfig({ ppq_private_enabled: true }, { warn: (message) => warnings.push(message) }).config, {});
    assert.match(warnings.join("\n"), /no API key/);
    assert.throws(() => prepareUserConfig(options({ model: "ppq-private/private/kimi-k2-5" })), /needs private mode/);
    assert.throws(() => prepareUserConfig(options({ model: "ppq-private/unknown" }, { ppq_private_enabled: true, ppq_api_key: fixtureKey })), /not in the managed model list/);
  });

  it("stages raw config and literal environment separately without losing mandatory managed policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "ha-v2-user-config-"));
    try {
      const input = join(root, "options.json");
      const output = join(root, "provider-env");
      const raw = options({ model: "fixture/coding", providers: { fixture: nativeProvider() }, formatter: false, websearch: { provider: "tavily" } });
      await writeFile(input, JSON.stringify(raw));
      const run = () => spawnSync(process.execPath, [generator, "--options-file", input, "--environment-output", output], { encoding: "utf8" });
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      const base = buildManagedConfig();
      for (const field of ["plugins", "permissions", "agents", "snapshots", "lsp", "skills", "autoupdate", "share"]) assert.deepEqual(config[field], base[field]);
      assert.equal(config.model, "fixture/coding");
      assert.equal(config.formatter, false);
      assert.deepEqual(config.websearch, { provider: "tavily" });
      assert.equal(await readFile(output, "utf8"), `FIXTURE_API_KEY=${fixtureKey}\0`);
      assert.ok(!(result.stdout + result.stderr).includes(fixtureKey));
      assert.deepEqual(JSON.parse(await readFile(input, "utf8")), raw);

      await writeFile(input, JSON.stringify(options({ plugins: [fixtureKey] })));
      const rejected = run();
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, "");
      assert.ok(!rejected.stderr.includes(fixtureKey));
      // Init's fresh temp files + ready marker gate prevent this earlier artifact
      // from being activated; failed validation does not overwrite any input.
      assert.equal(await readFile(output, "utf8"), `FIXTURE_API_KEY=${fixtureKey}\0`);

      await writeFile(input, "{}");
      assert.equal(run().status, 0);
      assert.equal((await readFile(output)).length, 0);
      for (const explicit of [true, false]) {
        await writeFile(input, JSON.stringify(options({ formatter: explicit })));
        const formatted = spawnSync(process.execPath, [generator, "--options-file", input,
          "--environment-output", output, "--yaml-formatting", String(!explicit)], { encoding: "utf8" });
        assert.equal(formatted.status, 0, formatted.stderr);
        const value = JSON.parse(formatted.stdout).formatter;
        if (explicit) assert.equal(value["ha-yaml"].disabled, false);
        else assert.equal(value, false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
