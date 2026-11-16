import { Plugin } from "@opencode/plugin";
import { resolveExternalServers, validateExternalServers } from "./external-mcp.js";

export const PLUGIN_ID = "homeassistant.mcp";
export const MCP_SERVER_NAME = "homeassistant";
export const NATIVE_MCP_SERVER_NAME = "homeassistant_native";
export const CALLER_SECRET_LIBRARY = "/usr/local/lib/opencode-v2-non-dumpable.so";

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

function requireLoopbackEndpoint(value, expectedPath, optionName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Home Assistant plugin option '${optionName}' is required`);
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError(`Home Assistant plugin option '${optionName}' must be an absolute URL`);
  }

  const loopback = endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "localhost"
    || endpoint.hostname === "[::1]";

  const fixedPath = endpoint.pathname === expectedPath && endpoint.search === "" && endpoint.hash === "";
  if (endpoint.protocol !== "http:" || !loopback || endpoint.username || endpoint.password || !fixedPath) {
    throw new TypeError(
      `Home Assistant plugin option '${optionName}' must be a plain loopback HTTP URL ending in ${expectedPath}`,
    );
  }

  return endpoint.toString();
}

function nativeEndpointFor(endpoint) {
  const native = new URL(endpoint);
  native.pathname = "/native-mcp";
  return native.toString();
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
  const allowed = new Set(["bundledEnabled", "endpoint", "nativeEnabled", "nativeEndpoint", "timeouts", "externalServers"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Home Assistant plugin option: ${unknown.join(", ")}`);
  }

  for (const name of ["bundledEnabled", "nativeEnabled"]) {
    if (input[name] !== undefined && typeof input[name] !== "boolean") {
      throw new TypeError(`Home Assistant plugin option '${name}' must be true or false`);
    }
  }
  // Omitted bundledEnabled preserves existing plugin configurations. An explicit
  // false allows native-only/external-only activation without acquiring needless
  // credentials or requiring an unused bundled endpoint.
  const bundledEnabled = input.bundledEnabled ?? true;
  const nativeEnabled = input.nativeEnabled ?? false;
  const endpoint = bundledEnabled || input.endpoint !== undefined
    ? requireLoopbackEndpoint(input.endpoint, "/mcp", "endpoint") : undefined;
  const nativeEndpoint = nativeEnabled || input.nativeEndpoint !== undefined || endpoint
    ? requireLoopbackEndpoint(input.nativeEndpoint ?? (endpoint ? nativeEndpointFor(endpoint) : undefined),
      "/native-mcp", "nativeEndpoint") : undefined;
  return {
    bundledEnabled,
    ...(endpoint ? { endpoint } : {}),
    nativeEnabled,
    ...(nativeEndpoint ? { nativeEndpoint } : {}),
    timeouts: requireTimeouts(input.timeouts),
    ...(input.externalServers === undefined ? {} : { externalServers: validateExternalServers(input.externalServers) }),
  };
}

function requireCallerSecret(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Home Assistant sidecar caller secret must be exactly 64 lowercase hexadecimal characters");
  }
  return value;
}

export async function readCallerSecret({
  loadFfi = () => import("bun:ffi"),
} = {}) {
  // The preloaded library owns the one-time broker result across all locations
  // and module generations. Never read or close a borrowed process descriptor.
  const buffer = Buffer.alloc(64);
  let library;
  try {
    const { dlopen, FFIType, ptr } = await loadFfi();
    library = dlopen(CALLER_SECRET_LIBRARY, {
      opencode_v2_copy_caller_secret: {
        args: [FFIType.ptr, FFIType.int],
        returns: FFIType.int,
      },
    });
    if (library.symbols.opencode_v2_copy_caller_secret(ptr(buffer), buffer.length) !== buffer.length) {
      throw new Error("Native caller credential unavailable");
    }
    return requireCallerSecret(buffer.toString("utf8"));
  } catch {
    // Do not attach an underlying error: plugin failures are written to logs.
    throw new Error("Home Assistant sidecar caller credential is unavailable; restart the beta app");
  } finally {
    buffer.fill(0);
    library?.close();
  }
}

export function createServerConfig(options, callerSecret, endpoint = options.endpoint) {
  return {
    type: "remote",
    url: endpoint,
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

export function createSetup({ readSecret = readCallerSecret, resolveExternal = resolveExternalServers } = {}) {
  return async function setup(ctx) {
    const input = requireObject(ctx.options);
    const options = parseOptions(input);
    const registrations = [];
    let managedFailed = false;
    if (options.bundledEnabled || options.nativeEnabled) {
      try {
        const callerSecret = requireCallerSecret(await readSecret());
        const server = options.bundledEnabled ? createServerConfig(options, callerSecret) : null;
        const nativeServer = options.nativeEnabled
          ? createServerConfig(options, callerSecret, options.nativeEndpoint) : null;
        registrations.push(await ctx.mcp.transform((draft) => {
          if (server) draft.set(MCP_SERVER_NAME, server);
          if (nativeServer) draft.set(NATIVE_MCP_SERVER_NAME, nativeServer);
        }));
      } catch {
        managedFailed = true;
      }
    }

    if (options.externalServers !== undefined) {
      try {
        const resolved = await resolveExternal(options.externalServers);
        if (Object.keys(resolved).length > 0) {
          registrations.push(await ctx.mcp.transform((draft) => {
            for (const [name, externalServer] of Object.entries(resolved)) draft.set(name, externalServer);
          }));
        }
      } catch {
        console.error("External MCP servers were not registered; check the add-on configuration, secret files, and local executables");
      }
    }

    if (managedFailed) {
      const message = "Home Assistant MCP registration failed; check the sidecar status and restart the app";
      // A broken HA boundary must not prevent unrelated external MCPs from
      // loading. Never attach the credential-bearing underlying exception.
      if (registrations.length === 0) throw new Error(message);
      console.error(message);
    }

    return async () => {
      await disposeRegistrations(registrations);
    };
  };
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: createSetup(),
});
