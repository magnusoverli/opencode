const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

test("the documented custom-provider example passes the pinned native validator", async () => {
  const root = path.join(__dirname, "..");
  const { prepareUserConfig } = await import(pathToFileURL(path.join(root, "rootfs/opt/opencode-v2-homeassistant/user-config.js")));
  const docs = fs.readFileSync(path.join(root, "DOCS.md"), "utf8");
  const section = docs.split("## Custom Providers and Configuration (Beta)")[1];
  assert.ok(section, "The operator configuration guide must exist");
  const example = /```json\s*([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(example, "The guide must include a native JSON example");
  const prepared = prepareUserConfig({
    opencode_config: example,
    env_vars: [{ name: "CUSTOM_API_KEY", value: "synthetic-documentation-fixture" }],
  });
  assert.equal(prepared.config.model, "custom/chat");
  assert.equal(prepared.config.providers.custom.models.chat.modelID, "your-model-id");
  assert.equal(prepared.config.providers.custom.settings.apiKey, "{env:CUSTOM_API_KEY}");
  assert.equal(prepared.config.providers.custom.settings.baseURL, "https://provider.example/v1");
});

test("the documented search selection passes native validation with a separately staged key", async () => {
  const root = path.join(__dirname, "..");
  const { prepareUserConfig } = await import(pathToFileURL(path.join(root, "rootfs/opt/opencode-v2-homeassistant/user-config.js")));
  const docs = fs.readFileSync(path.join(root, "DOCS.md"), "utf8");
  const section = docs.split("### Web search selection")[1];
  const example = /```json\s*([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(example, "The search guide must include a native JSON example");
  const result = prepareUserConfig({ opencode_config: example,
    env_vars: [{ name: "TAVILY_API_KEY", value: "synthetic-search-fixture" }],
  });
  assert.deepEqual(result.config.websearch, { provider: "tavily" });
  assert.equal(result.providerEnvironment.toString(), "TAVILY_API_KEY=synthetic-search-fixture\0");
  assert.ok(!JSON.stringify(result.config).includes("synthetic-search-fixture"));
});

test("the ProsperoAI inference-only recipe validates independently of optional MCP", async () => {
  const root = path.join(__dirname, "..");
  const { prepareUserConfig } = await import(pathToFileURL(path.join(root, "rootfs/opt/opencode-v2-homeassistant/user-config.js")));
  const section = fs.readFileSync(path.join(root, "DOCS.md"), "utf8").split("### Remote ProsperoAI example (#200)")[1];
  const example = /```json\s*([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(example);
  const input = { opencode_config: example, env_vars: [{ name: "PROSPEROAI_API_KEY", value: "synthetic-prospero-key" }] };
  const result = prepareUserConfig(input);
  assert.equal(result.config.model, "prosperoai/qwen3.8-9b-distill-q4-k-m.gguf");
  assert.equal(result.config.providers.prosperoai.models["qwen3.8-9b-distill-q4-k-m.gguf"].capabilities.tools, true);
  assert.deepEqual(result.externalMcp.servers, {});
  assert.ok(!JSON.stringify(result.config).includes("synthetic-prospero-key"));
  const parsed = JSON.parse(example); delete parsed.providers.prosperoai.settings.apiKey;
  assert.doesNotThrow(() => prepareUserConfig({ opencode_config: JSON.stringify(parsed) }));
});
