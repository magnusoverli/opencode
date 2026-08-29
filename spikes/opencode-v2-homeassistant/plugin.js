import { Plugin } from "@opencode-ai/plugin";

export const PLUGIN_ID = "homeassistant.mcp";
export const MCP_SERVER_NAME = "homeassistant";

const DEFAULT_TIMEOUTS = Object.freeze({
  startup: 30_000,
  catalog: 60_000,
  execution: 60_000,
});

function requireObject(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Home Assistant plugin options must be an object");
  }
  return value;
}

function requireLoopbackEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Home Assistant plugin option 'endpoint' is required");
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Home Assistant plugin option 'endpoint' must be an absolute URL");
  }

  const loopback = endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "localhost"
    || endpoint.hostname === "[::1]";

  const fixedPath = endpoint.pathname === "/mcp" && endpoint.search === "" && endpoint.hash === "";
  if (endpoint.protocol !== "http:" || !loopback || endpoint.username || endpoint.password || !fixedPath) {
    throw new TypeError("Home Assistant MCP endpoint must be a plain loopback HTTP URL ending in /mcp");
  }

  return endpoint.toString();
}

function requireTimeouts(value) {
  if (value === undefined) return { ...DEFAULT_TIMEOUTS };
  const input = requireObject(value);
  const result = { ...DEFAULT_TIMEOUTS };

  for (const key of Object.keys(result)) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || input[key] <= 0) {
      throw new TypeError(`Home Assistant MCP timeout '${key}' must be a positive integer`);
    }
    result[key] = input[key];
  }

  const unknown = Object.keys(input).filter((key) => !(key in result));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Home Assistant MCP timeout option: ${unknown.join(", ")}`);
  }

  return result;
}

export function parseOptions(value) {
  const input = requireObject(value);
  const allowed = new Set(["endpoint", "timeouts"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Home Assistant plugin option: ${unknown.join(", ")}`);
  }

  return {
    endpoint: requireLoopbackEndpoint(input.endpoint),
    timeouts: requireTimeouts(input.timeouts),
  };
}

export function createServerConfig(options) {
  return {
    type: "remote",
    url: options.endpoint,
    oauth: false,
    disabled: false,
    codemode: false,
    timeout: { ...options.timeouts },
  };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    const server = createServerConfig(options);
    const registration = await ctx.mcp.transform((draft) => {
      draft.set(MCP_SERVER_NAME, server);
    });

    return async () => {
      await registration.dispose();
    };
  },
});
