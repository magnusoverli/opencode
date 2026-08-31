import { closeSync, readFileSync } from "node:fs";
import { Plugin } from "@opencode-ai/plugin";

export const PLUGIN_ID = "homeassistant.mcp";
export const MCP_SERVER_NAME = "homeassistant";
export const CALLER_SECRET_FD = 3;

const SENSITIVE_SHELL_ENV = new Set([
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "SUPERVISOR_TOKEN",
  "HA_TOKEN",
  "HA_ACCESS_TOKEN",
  "LD_PRELOAD",
]);

const SIDECAR_NAMESPACE = /(?:^|_)(?:MCP|SIDECAR)(?:_|$)/;
const CREDENTIAL_NAME = /(?:^|_)(?:AUTH(?:ORIZATION)?|BEARER|CALLER|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/;

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

function requireCallerSecret(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Home Assistant sidecar caller secret must be exactly 64 lowercase hexadecimal characters");
  }
  return value;
}

export function readCallerSecret({
  fd = CALLER_SECRET_FD,
  read = readFileSync,
  close = closeSync,
} = {}) {
  let value;
  try {
    value = read(fd, "utf8");
  } finally {
    close(fd);
  }
  return requireCallerSecret(value);
}

export function createServerConfig(options, callerSecret) {
  return {
    type: "remote",
    url: options.endpoint,
    headers: { Authorization: `Bearer ${requireCallerSecret(callerSecret)}` },
    oauth: false,
    disabled: false,
    codemode: false,
    timeout: { ...options.timeouts },
  };
}

export function scrubShellEnvironment(input) {
  for (const name of Object.keys(input.env)) {
    const normalized = name.toUpperCase();
    if (SENSITIVE_SHELL_ENV.has(normalized)
      || (SIDECAR_NAMESPACE.test(normalized) && CREDENTIAL_NAME.test(normalized))) {
      delete input.env[name];
    }
  }
}

export function scrubParentEnvironment(environment = process.env) {
  scrubShellEnvironment({ env: environment });
}

async function disposeRegistrations(registrations) {
  const errors = [];
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Home Assistant plugin registrations");
}

export function createSetup({ readSecret = readCallerSecret } = {}) {
  return async function setup(ctx) {
    const callerSecret = readSecret();
    const options = parseOptions(ctx.options);
    const server = createServerConfig(options, callerSecret);
    const registrations = [await ctx.mcp.transform((draft) => {
      draft.set(MCP_SERVER_NAME, server);
    })];

    return async () => {
      await disposeRegistrations(registrations);
    };
  };
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: createSetup(),
});
