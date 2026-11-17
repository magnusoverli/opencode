import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "../rootfs/opt/ha-mcp-server/node_modules/yaml/dist/index.js";
import { buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { prepareUserConfig } from "../rootfs/opt/opencode-v2-homeassistant/user-config.js";

const addon = new URL("../", import.meta.url);
const generator = fileURLToPath(new URL("rootfs/opt/opencode-v2-homeassistant/managed-config.js", addon));
const fixtureSecret = "custom-plugin-secret-do-not-log";
const plugins = [
  "example-plugin@1.2.0",
  "github:example/plugin#0123456789012345678901234567890123456789",
  { package: "/data/plugins/local", options: { enabled: true, nested: { key: fixtureSecret } } },
  "*", "-example.disabled", "-homeassistant.context", "example.disabled",
];
const options = (plugins, enabled) => ({
  ...(enabled === undefined ? {} : { custom_plugins_enabled: enabled }),
  opencode_config: JSON.stringify({ model: "fixture/coding", plugins }),
});

describe("opt-in upstream V2 plugin configuration", () => {
  it("declares a default-off option in matching schema order with translated trust/recovery guidance", async () => {
    const config = parse(await readFile(new URL("config.yaml", addon), "utf8"));
    const translation = parse(await readFile(new URL("translations/en.yaml", addon), "utf8"));
    assert.equal(config.options.custom_plugins_enabled, false);
    assert.equal(config.schema.custom_plugins_enabled, "bool");
    // Supervisor merges image defaults into saved options. Native defaults must
    // instead be resolved by startup with fresh/legacy installation provenance.
    const startupNativeKeys = ["native_ha_mcp_enabled", "native_ha_mcp_selection", "native_ha_mcp_api_id"];
    for (const key of startupNativeKeys) {
      assert.equal(Object.hasOwn(config.options, key), false, `${key} must not acquire an image default`);
      assert.match(config.schema[key], /\?$/);
      assert.ok(translation.configuration[key], `${key} needs configuration help`);
    }
    assert.deepEqual(Object.keys(config.options), Object.keys(config.schema).filter((key) => !startupNativeKeys.includes(key)));
    assert.equal(translation.configuration.custom_plugins_enabled.name, "Enable third-party plugins");
    assert.match(translation.configuration.custom_plugins_enabled.description, /root-level.*Turn off and restart/);
  });

  it("ignores saved entries before validation unless the option is exactly true", () => {
    for (const enabled of [undefined, false, "true", 1]) {
      for (const entries of [plugins, null, false, 123, { package: fixtureSecret }]) {
        const input = options(entries, enabled);
        const original = structuredClone(input);
        const warnings = [];
        const result = prepareUserConfig(input, { warn: (message) => warnings.push(message) });
        assert.deepEqual(result.config, { model: "fixture/coding" });
        assert.deepEqual(input, original);
        assert.match(warnings.join("\n"), /ignored.*saved options are unchanged/);
        assert.ok(!warnings.join("\n").includes(fixtureSecret));
      }
    }
  });

  it("passes native package/path entries, options and selector ordering through unchanged", () => {
    const input = options(plugins, true);
    const original = structuredClone(input);
    const warnings = [];
    const result = prepareUserConfig(input, { warn: (message) => warnings.push(message) });
    assert.deepEqual(result.config.plugins, plugins);
    assert.deepEqual(input, original);
    assert.equal(result.providerEnvironment.length, 0);
    assert.match(warnings.join("\n"), /trusted root-level.*upstream handles loading/);
    assert.ok(!warnings.join("\n").includes(fixtureSecret));
  });

  it("leaves plugin substitutions to upstream rather than applying provider-only policy", () => {
    const entries = [{ package: "example-plugin", options: { file: "{file:/data/plugins/settings}", env: "{env:PLUGIN_SETTING}" } }];
    assert.deepEqual(prepareUserConfig(options(entries, true)).config.plugins, entries);
    assert.throws(() => prepareUserConfig({ custom_plugins_enabled: true, opencode_config: JSON.stringify({
      plugins, providers: { fixture: { settings: { apiKey: "{env:SUPERVISOR_TOKEN}" } } },
    }) }), /supported provider/);
  });

  it("rejects malformed enabled entries through the pinned native schema without echoing values", () => {
    for (const entries of [null, false, {}, [123], [{ package: 123, options: { key: fixtureSecret } }]]) {
      assert.throws(() => prepareUserConfig(options(entries, true)), (error) => {
        assert.match(error.message, /native V2 schema validation failed/);
        assert.ok(!error.message.includes(fixtureSecret));
        return true;
      });
    }
  });

  it("does not unlock unrelated managed fields and preserves empty/no-entry defaults", () => {
    for (const field of ["permissions", "agents", "lsp", "instructions", "snapshots"]) {
      assert.throws(() => prepareUserConfig({ custom_plugins_enabled: true, opencode_config: JSON.stringify({ [field]: {} }) }), /unsupported fields/);
    }
    assert.deepEqual(prepareUserConfig({ custom_plugins_enabled: true }).config, {});
    assert.deepEqual(prepareUserConfig(options([], true)).config.plugins, []);
  });

  it("appends after bundled entries, preserves managed defaults and survives disable/re-enable without rewriting options", async () => {
    const root = await mkdtemp(join(tmpdir(), "ha-v2-custom-plugins-"));
    try {
      const input = join(root, "options.json");
      const output = join(root, "provider-env");
      const base = buildManagedConfig({ pluginEnabled: true, lspEnabled: true, assistEnabled: true });
      const run = () => spawnSync(process.execPath, [generator,
        "--options-file", input, "--environment-output", output,
        "--plugin-enabled", "true", "--lsp-enabled", "true", "--assist-enabled", "true",
      ], { encoding: "utf8", timeout: 30_000 });
      for (const enabled of [true, false, true]) {
        const raw = JSON.stringify(options(plugins, enabled));
        await writeFile(input, raw);
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        const generated = JSON.parse(result.stdout);
        assert.deepEqual(generated.plugins, [...base.plugins, ...(enabled ? plugins : [])]);
        assert.deepEqual(generated.permissions, base.permissions);
        assert.deepEqual(generated.agents, base.agents);
        assert.equal(generated.model, "fixture/coding");
        assert.equal(await readFile(input, "utf8"), raw);
        assert.equal(await readFile(output, "utf8"), "");
        assert.ok(!result.stderr.includes(fixtureSecret));
      }
      await writeFile(input, JSON.stringify(options({ malformed: fixtureSecret }, true)));
      const invalid = run();
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.ok(!invalid.stderr.includes(fixtureSecret));
      await writeFile(input, JSON.stringify(options({ malformed: fixtureSecret }, false)));
      const recovered = run();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(JSON.parse(recovered.stdout).plugins, base.plugins);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("documents upstream ownership, persistent absolute paths, trusted code and recovery without enabling project discovery", async () => {
    const docs = await readFile(new URL("DOCS.md", addon), "utf8");
    for (const text of ["custom_plugins_enabled", "https://opencode.ai/docs/plugins", "/data/plugins/my-plugin",
      "root-level code", "before their", "Client/TUI-only", "not an add-on plugin manager"]) {
      assert.ok(docs.includes(text), `Missing documented contract: ${text}`);
    }
    const launcher = await readFile(new URL("rootfs/opt/opencode-v2-homeassistant/secure-launcher.c", addon), "utf8");
    assert.ok(launcher.includes('SET_ENV("OPENCODE_DISABLE_PROJECT_CONFIG", "1")'));
    assert.ok(launcher.includes("project .opencode content is not allowed"));
  });
});
