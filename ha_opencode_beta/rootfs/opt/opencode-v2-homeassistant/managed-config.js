import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { TOOL_PROFILES } from "../ha-mcp-server/lib/tool-profiles.js";
import { prepareUserConfig } from "./user-config.js";
import { resolveMcpConfiguration } from "./mcp-config.js";

export const DEFAULT_PLUGIN_PACKAGE = "file:///opt/opencode-v2-homeassistant/mcp-plugin";
export const DEFAULT_RUNTIME_GUARD_PACKAGE = "file:///opt/opencode-v2-homeassistant/runtime-guard-plugin";
export const DEFAULT_CONTEXT_PACKAGE = "file:///opt/opencode-v2-homeassistant/context-plugin";
export const DEFAULT_LSP_PACKAGE = "file:///opt/opencode-v2-homeassistant/lsp-plugin";
export const DEFAULT_PPQ_PACKAGE = "file:///opt/opencode-v2-homeassistant/ppq-plugin";
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:8765/mcp";
export const DEFAULT_NATIVE_MCP_ENDPOINT = "http://127.0.0.1:8765/native-mcp";
export const DEFAULT_WORKSPACE = "/homeassistant";
export const WORKSPACE_INSTRUCTIONS = "/opt/opencode-v2-homeassistant/WORKSPACE.md";
export const READ_ONLY_AGENT_ID = "home-assistant-read-only";
export const READ_ONLY_AGENT_SYSTEM = [
  "Investigate and diagnose Home Assistant without changing it.",
  "Runtime policy allows file reads, path globbing, and the compact Home Assistant diagnostic tools only; content search, edits, shell commands, subagents, LSP, and every unknown action are denied.",
  "End with findings and recommendations rather than attempting a fix.",
].join(" ");

const WATCHER_IGNORES = Object.freeze([
  ".git/**",
  ".storage/**",
  ".cloud/**",
  ".cache/**",
  ".local/**",
  "deps/**",
  "tts/**",
  "__pycache__/**",
  "node_modules/**",
  "home-assistant_v2.db*",
  "*.log",
]);

// Managed Prettier/Biome extensions, minus YAML. A project-local
// formatter must not silently undo the add-on's minimal-diff default.
const NON_YAML_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".json", ".jsonc",
  ".toml", ".xml", ".md", ".mdx", ".graphql", ".gql"];

const SENSITIVE_READ_PATTERNS = Object.freeze([
  "*secrets.yaml",
  "*.storage/*",
  "*.cloud/*",
  "*ssl/*",
  "*.key",
  "*.pem",
  "/data/.config/opencode/mcp-secrets/*",
]);

export function buildReadOnlyPermissions(workspace = DEFAULT_WORKSPACE) {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "external_directory", resource: workspace, effect: "allow" },
    { action: "external_directory", resource: `${workspace}/**`, effect: "allow" },
    { action: "homeassistant_*", resource: "*", effect: "deny" },
    ...[...TOOL_PROFILES.compact.toolNames].map((name) => ({
      action: `homeassistant_${name}`,
      resource: "*",
      effect: "allow",
    })),
    { action: "homeassistant_native_*", resource: "*", effect: "deny" },
    ...SENSITIVE_READ_PATTERNS.map((resource) => ({ action: "read", resource, effect: "deny" })),
  ];
}

export function buildManagedConfig({
  restrictSensitiveFiles = true,
  pluginEnabled = false,
  pluginPackage = DEFAULT_PLUGIN_PACKAGE,
  runtimeGuardPackage = DEFAULT_RUNTIME_GUARD_PACKAGE,
  mcpEndpoint = DEFAULT_MCP_ENDPOINT,
  nativeMcpEnabled = false,
  nativeMcpEndpoint = DEFAULT_NATIVE_MCP_ENDPOINT,
  mcpProfile = "full",
  workspace = DEFAULT_WORKSPACE,
  focusMode = false,
  homeBriefing = true,
  decisionNotes = true,
  userHooks = false,
  lspEnabled = false,
  assistEnabled = false,
  yamlFormatting = false,
  mcpSettings,
} = {}) {
  // Startup can opt into the shared contract only after establishing provenance
  // and verifying persistence. Existing CLI flags remain unchanged meanwhile.
  if (mcpSettings !== undefined) {
    const resolved = resolveMcpConfiguration(mcpSettings);
    pluginEnabled = resolved.bundled.enabled;
    nativeMcpEnabled = resolved.native.enabled;
    mcpProfile = resolved.bundled.profile;
  }
  const permissions = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: "yq -i*", effect: "ask" },
    { action: "shell", resource: "sed -i*", effect: "ask" },
    { action: "shell", resource: "tee *", effect: "ask" },
    { action: "shell", resource: "rm *", effect: "ask" },
    { action: "shell", resource: "mv *", effect: "ask" },
    { action: "external_directory", resource: workspace, effect: "allow" },
    { action: "external_directory", resource: `${workspace}/**`, effect: "allow" },
  ];

  if (restrictSensitiveFiles) {
    for (const resource of SENSITIVE_READ_PATTERNS) {
      permissions.push({ action: "read", resource, effect: "deny" });
    }
  }
  if (lspEnabled) permissions.push({ action: "lsp", resource: "*", effect: "allow" });

  const plugins = [
    { package: runtimeGuardPackage },
    ...(pluginEnabled || nativeMcpEnabled
      ? [{
        package: pluginPackage,
        options: {
          bundledEnabled: pluginEnabled,
          endpoint: mcpEndpoint,
          nativeEnabled: nativeMcpEnabled,
          nativeEndpoint: nativeMcpEndpoint,
          timeouts: { startup: 30_000, catalog: 60_000, execution: 60_000 },
        },
      }]
      : []),
  ];
  const instructions = [
    WORKSPACE_INSTRUCTIONS,
    ...(focusMode ? ["/opt/ha-mcp-server/FOCUS_MODE.md"] : []),
    ...(pluginEnabled
      ? [
        "/opt/ha-mcp-server/MCP_CORE_INSTRUCTIONS.md",
        `/opt/ha-mcp-server/MCP_PROFILE_${mcpProfile.toUpperCase()}.md`,
      ]
      : []),
    ...(nativeMcpEnabled ? ["/opt/ha-mcp-server/MCP_NATIVE_INSTRUCTIONS.md"] : []),
    ...(homeBriefing ? ["/data/context/home-briefing.md"] : []),
    ...(decisionNotes ? ["/data/context/decision-notes.md"] : []),
    ...(userHooks ? ["/opt/ha-mcp-server/USER_HOOKS.md"] : []),
    `${workspace}/AGENTS.local.md`,
  ];
  plugins.push({ package: DEFAULT_CONTEXT_PACKAGE, options: { files: instructions } });
  if (lspEnabled) plugins.push({ package: DEFAULT_LSP_PACKAGE });
  if (assistEnabled) plugins.push({ package: "file:///opt/opencode-v2-homeassistant/assist-plugin" });

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshots: false,
    permissions,
    watcher: { ignore: [...WATCHER_IGNORES] },
    formatter: {
      ...(!yamlFormatting ? {
        prettier: { extensions: [...NON_YAML_EXTENSIONS] },
        biome: { extensions: [...NON_YAML_EXTENSIONS] },
      } : {}),
      "ha-yaml": { command: ["prettier", "--write", "$FILE"], extensions: [".yaml", ".yml"], disabled: !yamlFormatting },
    },
    lsp: false,
    skills: ["/data/.config/opencode/skills"],
    agents: {
      ...(assistEnabled ? { "home-assistant-assist": {
        description: "Private HA request adapter; use the companion integration.",
        mode: "primary", hidden: true,
        system: "Respond only within the supplied Home Assistant request.",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      } } : {}),
      [READ_ONLY_AGENT_ID]: {
        description: "Investigate and diagnose Home Assistant with no ability to change anything.",
        mode: "primary",
        system: READ_ONLY_AGENT_SYSTEM,
        permissions: buildReadOnlyPermissions(workspace),
      },
    },
    plugins,
  };
}

export function applyExternalMcpConfig(managed, externalMcp) {
  if (!externalMcp || Object.keys(externalMcp.servers).length === 0) return managed;
  let plugin = managed.plugins.find(({ package: name }) => name === DEFAULT_PLUGIN_PACKAGE);
  if (!plugin) {
    plugin = { package: DEFAULT_PLUGIN_PACKAGE, options: { bundledEnabled: false, nativeEnabled: false } };
    managed.plugins.push(plugin);
  }
  plugin.options.externalServers = externalMcp.servers;
  managed.permissions.push(...externalMcp.permissions);
  return managed;
}

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} requires a value`);
    if (name === "--options-file") {
      options.optionsFile = value;
    } else if (name === "--mcp-settings-file") {
      options.mcpSettingsFile = value;
    } else if (name === "--environment-output") {
      options.environmentOutput = value;
    } else if (name === "--external-mcp-output") {
      options.externalMcpOutput = value;
    } else if (name === "--restrict-sensitive-files") {
      options.restrictSensitiveFiles = parseBoolean(value, name);
    } else if (name === "--plugin-enabled") {
      options.pluginEnabled = parseBoolean(value, name);
    } else if (name === "--plugin-package") {
      options.pluginPackage = value;
    } else if (name === "--mcp-endpoint") {
      options.mcpEndpoint = value;
    } else if (name === "--assist-enabled") {
      options.assistEnabled = parseBoolean(value, name);
    } else if (name === "--native-mcp-enabled") {
      options.nativeMcpEnabled = parseBoolean(value, name);
    } else if (name === "--native-mcp-endpoint") {
      options.nativeMcpEndpoint = value;
    } else if (name === "--mcp-profile") {
      if (!["compact", "configuration", "full"].includes(value)) {
        throw new TypeError(`${name} must be compact, configuration, or full`);
      }
      options.mcpProfile = value;
    } else if (name === "--workspace") {
      if (!value.startsWith("/")) throw new TypeError(`${name} must be absolute`);
      options.workspace = value.replace(/\/$/, "");
    } else if (name === "--focus-mode") {
      options.focusMode = parseBoolean(value, name);
    } else if (name === "--home-briefing") {
      options.homeBriefing = parseBoolean(value, name);
    } else if (name === "--decision-notes") {
      options.decisionNotes = parseBoolean(value, name);
    } else if (name === "--user-hooks") {
      options.userHooks = parseBoolean(value, name);
    } else if (name === "--lsp-enabled") {
      options.lspEnabled = parseBoolean(value, name);
    } else if (name === "--yaml-formatting") {
      options.yamlFormatting = parseBoolean(value, name);
    } else {
      throw new TypeError(`Unknown managed-config option: ${name}`);
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.mcpSettingsFile) {
      try { args.mcpSettings = JSON.parse(readFileSync(args.mcpSettingsFile, "utf8")).settings; }
      catch { throw new TypeError("Cannot read verified startup MCP settings"); }
      if (!args.mcpSettings) throw new TypeError("Verified startup MCP settings are missing");
    }
    const managed = buildManagedConfig(args);
    let externalMcp = { servers: {}, permissions: [] };
    if (args.optionsFile) {
      if (!args.environmentOutput) throw new TypeError("--options-file requires --environment-output");
      let options;
      try { options = JSON.parse(readFileSync(args.optionsFile, "utf8")); }
      catch { throw new TypeError("Cannot read add-on options as JSON; no custom configuration was applied"); }
      const prepared = prepareUserConfig(options, {
        warn: (message) => process.stderr.write(`${message}\n`),
      });
      // Keep bundled entries in the generated config; append custom entries
      // after all bundled registrations. Upstream owns selector/load semantics.
      const { plugins: customPlugins = [], ...customConfig } = prepared.config;
      Object.assign(managed, customConfig);
      if (prepared.config.providers?.["ppq-private"]) managed.plugins.push({
        package: DEFAULT_PPQ_PACKAGE,
        options: { defaultModel: prepared.config.model?.startsWith("ppq-private/") ? prepared.config.model.slice("ppq-private/".length) : undefined },
      });
      // Explicit false disables all formatting. Explicit true opts into YAML
      // as well; otherwise the targeted add-on setting controls YAML alone.
      if (prepared.config.formatter === true) {
        managed.formatter = buildManagedConfig({ yamlFormatting: true }).formatter;
      }
      externalMcp = prepared.externalMcp;
      applyExternalMcpConfig(managed, externalMcp);
      managed.plugins.push(...customPlugins);
      writeFileSync(args.environmentOutput, prepared.providerEnvironment, { mode: 0o600 });
    } else if (args.environmentOutput) {
      throw new TypeError("--environment-output requires --options-file");
    }
    if (args.externalMcpOutput) {
      const enabledNames = Object.entries(externalMcp.servers)
        .filter(([, server]) => server.enabled)
        .map(([name]) => name);
      writeFileSync(args.externalMcpOutput, `${JSON.stringify(enabledNames)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(managed, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
