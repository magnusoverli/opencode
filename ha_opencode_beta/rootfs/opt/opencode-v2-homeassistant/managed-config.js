import { pathToFileURL } from "node:url";
import { TOOL_PROFILES } from "../ha-mcp-server/lib/tool-profiles.js";

export const DEFAULT_PLUGIN_PACKAGE = "file:///opt/opencode-v2-homeassistant/plugin.js";
export const DEFAULT_RUNTIME_GUARD_PACKAGE = "file:///opt/opencode-v2-homeassistant/runtime-guard.js";
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:8765/mcp";
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

const SENSITIVE_READ_PATTERNS = Object.freeze([
  "*secrets.yaml",
  "*.storage/*",
  "*.cloud/*",
  "*ssl/*",
  "*.key",
  "*.pem",
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
    ...SENSITIVE_READ_PATTERNS.map((resource) => ({ action: "read", resource, effect: "deny" })),
  ];
}

export function buildManagedConfig({
  restrictSensitiveFiles = true,
  pluginEnabled = false,
  pluginPackage = DEFAULT_PLUGIN_PACKAGE,
  runtimeGuardPackage = DEFAULT_RUNTIME_GUARD_PACKAGE,
  mcpEndpoint = DEFAULT_MCP_ENDPOINT,
  mcpProfile = "full",
  workspace = DEFAULT_WORKSPACE,
  focusMode = false,
  homeBriefing = true,
  decisionNotes = true,
  userHooks = false,
} = {}) {
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

  const plugins = [
    { package: runtimeGuardPackage },
    ...(pluginEnabled
      ? [{
        package: pluginPackage,
        options: {
          endpoint: mcpEndpoint,
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
    ...(homeBriefing ? ["/data/context/home-briefing.md"] : []),
    ...(decisionNotes ? ["/data/context/decision-notes.md"] : []),
    ...(userHooks ? ["/opt/ha-mcp-server/USER_HOOKS.md"] : []),
    `${workspace}/AGENTS.local.md`,
  ];

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshots: false,
    permissions,
    watcher: { ignore: [...WATCHER_IGNORES] },
    formatter: false,
    lsp: false,
    skills: ["/opt/ha-mcp-server/skills"],
    instructions,
    agents: {
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
    if (name === "--restrict-sensitive-files") {
      options.restrictSensitiveFiles = parseBoolean(value, name);
    } else if (name === "--plugin-enabled") {
      options.pluginEnabled = parseBoolean(value, name);
    } else if (name === "--plugin-package") {
      options.pluginPackage = value;
    } else if (name === "--mcp-endpoint") {
      options.mcpEndpoint = value;
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
    } else {
      throw new TypeError(`Unknown managed-config option: ${name}`);
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(buildManagedConfig(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
