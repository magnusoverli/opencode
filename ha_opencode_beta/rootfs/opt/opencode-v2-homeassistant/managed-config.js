import { pathToFileURL } from "node:url";

export const DEFAULT_PLUGIN_PACKAGE = "file:///opt/opencode-v2-homeassistant/plugin.js";
export const DEFAULT_RUNTIME_GUARD_PACKAGE = "file:///opt/opencode-v2-homeassistant/runtime-guard.js";
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:8765/mcp";

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

export function buildManagedConfig({
  restrictSensitiveFiles = true,
  pluginEnabled = false,
  pluginPackage = DEFAULT_PLUGIN_PACKAGE,
  runtimeGuardPackage = DEFAULT_RUNTIME_GUARD_PACKAGE,
  mcpEndpoint = DEFAULT_MCP_ENDPOINT,
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
    { action: "external_directory", resource: "/homeassistant", effect: "allow" },
    { action: "external_directory", resource: "/homeassistant/**", effect: "allow" },
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
