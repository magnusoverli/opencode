import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const EXTERNAL_MCP_SECRET_ROOT = "/data/.config/opencode/mcp-secrets";
export const EXTERNAL_MCP_BIN_ROOT = "/data/.config/opencode/bin/";
export const EXTERNAL_MCP_LAUNCHER = "/usr/local/bin/opencode-v2-external-mcp-launch";
export const EXTERNAL_MCP_UID_BASE = 61_000;

const RESERVED_SERVER_NAMES = new Set(["homeassistant", "homeassistant_native"]);
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_LOCAL_ENVIRONMENT = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/;
const LITERAL_REMOTE_HEADERS = new Set(["accept", "content-type", "host", "user-agent"]);
const SECRET_REFERENCE = /^\{file:(?:\/data\/\.config\/opencode\/mcp-secrets\/)?([^}/]+)\}$/;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

function invalid(message) {
  throw new TypeError(`external_mcp_config: ${message}`);
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

function singleLine(value, label) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`${label} must be a nonempty single-line string`);
  }
}

function secretName(value) {
  if (typeof value !== "string") return null;
  const match = value.match(SECRET_REFERENCE);
  if (!match || !SECRET_NAME.test(match[1])) return null;
  return match[1];
}

function valueReference(value, label, { credential = false } = {}) {
  singleLine(value, label);
  if (value.includes("{file:") && !secretName(value)) {
    invalid(`${label} uses an invalid secret reference`);
  }
  if (/\{env:/.test(value)) invalid(`${label} cannot use environment substitution`);
  if (credential && !secretName(value)) invalid(`${label} must use a secret file reference`);
  return value;
}

function timeout(value, label) {
  if (value === undefined) return undefined;
  fields(value, ["startup", "catalog", "execution"], label);
  for (const item of Object.values(value)) {
    if (!Number.isSafeInteger(item) || item <= 0 || item > 600_000) {
      invalid(`${label} values must be positive integers no greater than 600000`);
    }
  }
  return { ...value };
}

function remoteHeaderValue(value, label, { literalAllowed }) {
  if (typeof value === "string") {
    if (!literalAllowed) invalid(`${label} must use a secret file descriptor`);
    singleLine(value, label);
    if (value.includes("{file:") || value.includes("{env:")) invalid(`${label} must contain a literal value`);
    return value;
  }
  fields(value, ["secret_file", "prefix"], label);
  if (typeof value.secret_file !== "string" || !SECRET_NAME.test(value.secret_file)) {
    invalid(`${label}.secret_file is invalid`);
  }
  const prefix = value.prefix ?? "";
  if (typeof prefix !== "string" || prefix.length > 64 || /[\x00-\x1f\x7f]/.test(prefix)) {
    invalid(`${label}.prefix must be a single-line string no longer than 64 characters`);
  }
  return { secret_file: value.secret_file, prefix };
}

function remoteServer(value, label) {
  fields(value, ["type", "url", "headers", "enabled", "timeout", "allow_insecure"], label);
  let url;
  try { url = new URL(value.url); }
  catch { invalid(`${label}.url must be an absolute HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    invalid(`${label}.url must be an absolute HTTP(S) URL without credentials or a fragment`);
  }
  if (value.allow_insecure !== undefined && typeof value.allow_insecure !== "boolean") {
    invalid(`${label}.allow_insecure must be true or false`);
  }
  if (url.protocol === "http:" && !value.allow_insecure) {
    invalid(`${label}.allow_insecure must be true for plaintext HTTP`);
  }
  const headers = {};
  if (value.headers !== undefined) {
    object(value.headers, `${label}.headers`);
    if (Object.keys(value.headers).length > 64) invalid(`${label}.headers exceeds 64 entries`);
    for (const [name, item] of Object.entries(value.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) invalid(`${label}.headers contains an invalid name`);
      headers[name] = remoteHeaderValue(item, `${label}.headers.${name}`, {
        literalAllowed: LITERAL_REMOTE_HEADERS.has(name.toLowerCase()),
      });
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") invalid(`${label}.enabled must be true or false`);
  return {
    type: "remote",
    url: url.toString(),
    headers,
    enabled: value.enabled ?? true,
    ...(url.protocol === "http:" ? { allow_insecure: true } : {}),
    ...(value.timeout === undefined ? {} : { timeout: timeout(value.timeout, `${label}.timeout`) }),
  };
}

function localServer(value, label) {
  fields(value, ["type", "command", "environment", "literal_environment", "enabled", "timeout"], label);
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.length > 64) {
    invalid(`${label}.command must contain 1-64 arguments`);
  }
  value.command.forEach((item) => singleLine(item, `${label}.command`));
  if (!value.command[0].startsWith(EXTERNAL_MCP_BIN_ROOT) || value.command[0].slice(EXTERNAL_MCP_BIN_ROOT.length).includes("/")) {
    invalid(`${label}.command executable must be directly inside /data/.config/opencode/bin`);
  }
  const environment = {};
  if (value.environment !== undefined) {
    object(value.environment, `${label}.environment`);
    if (Object.keys(value.environment).length > 64) invalid(`${label}.environment exceeds 64 entries`);
    for (const [name, item] of Object.entries(value.environment)) {
      if (!ENVIRONMENT_NAME.test(name) || RESERVED_LOCAL_ENVIRONMENT.test(name)) invalid(`${label}.environment contains an invalid or reserved name`);
      environment[name] = valueReference(item, `${label}.environment`, { credential: true });
    }
  }
  const literalEnvironment = {};
  if (value.literal_environment !== undefined) {
    object(value.literal_environment, `${label}.literal_environment`);
    if (Object.keys(value.literal_environment).length > 64) invalid(`${label}.literal_environment exceeds 64 entries`);
    for (const [name, item] of Object.entries(value.literal_environment)) {
      if (!ENVIRONMENT_NAME.test(name) || RESERVED_LOCAL_ENVIRONMENT.test(name) || Object.hasOwn(environment, name)) {
        invalid(`${label}.literal_environment contains an invalid, reserved or duplicate name`);
      }
      singleLine(item, `${label}.literal_environment`);
      if (item.includes("{file:") || item.includes("{env:")) invalid(`${label}.literal_environment must contain literal values`);
      literalEnvironment[name] = item;
    }
  }
  if (Object.keys(environment).length + Object.keys(literalEnvironment).length > 64) {
    invalid(`${label} environment exceeds 64 combined entries`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") invalid(`${label}.enabled must be true or false`);
  return {
    type: "local",
    command: [...value.command],
    environment,
    literal_environment: literalEnvironment,
    enabled: value.enabled ?? true,
    ...(value.timeout === undefined ? {} : { timeout: timeout(value.timeout, `${label}.timeout`) }),
  };
}

export function validateExternalServers(value) {
  object(value, "servers");
  if (Object.keys(value).length > 16) invalid("servers exceeds 16 entries");
  const servers = {};
  for (const [name, server] of Object.entries(value)) {
    if (!SERVER_NAME.test(name) || RESERVED_SERVER_NAMES.has(name)) invalid("server names must be safe, unique and non-reserved");
    object(server, `server '${name}'`);
    if (server.type === "remote") servers[name] = remoteServer(server, `server '${name}'`);
    else if (server.type === "local") servers[name] = localServer(server, `server '${name}'`);
    else invalid(`server '${name}'.type must be remote or local`);
  }
  return servers;
}

function permissions(value, serverNames) {
  if (value === undefined) return [];
  object(value, "permissions");
  if (Object.keys(value).length > 512) invalid("permissions exceeds 512 entries");
  const result = [];
  for (const name of serverNames) {
    result.push({ action: `${name}_*`, resource: "*", effect: "ask" });
  }
  for (const [action, effect] of Object.entries(value)) {
    if (!serverNames.some((name) => action.startsWith(`${name}_`)) || !/^[A-Za-z0-9_.*-]+$/.test(action)) {
      invalid("permission actions must target a configured external MCP server");
    }
    if (!["allow", "ask", "deny"].includes(effect)) invalid("permission effects must be allow, ask or deny");
    result.push({ action, resource: "*", effect });
  }
  return result;
}

export function extractLegacyExternalMcpConfig(config) {
  if (!Object.hasOwn(config, "mcp") && !Object.hasOwn(config, "permission")) return null;
  const legacyServers = config.mcp ?? {};
  object(legacyServers, "legacy mcp");
  const servers = {};
  for (const [name, value] of Object.entries(legacyServers)) {
    object(value, `legacy server '${name}'`);
    if (value.oauth !== undefined && value.oauth !== false) invalid("legacy external MCP OAuth must be disabled");
    const server = { ...value };
    delete server.oauth;
    if (server.type === "remote" && typeof server.url === "string") {
      try { if (new URL(server.url).protocol === "http:") server.allow_insecure = true; } catch {}
    }
    if (server.type === "remote" && server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)) {
      server.headers = Object.fromEntries(Object.entries(server.headers).map(([headerName, headerValue]) => {
        if (typeof headerValue !== "string" || LITERAL_REMOTE_HEADERS.has(headerName.toLowerCase())) return [headerName, headerValue];
        const match = headerValue.match(/^([^\x00-\x1f\x7f]{0,64})\{file:(?:\/data\/\.config\/opencode\/mcp-secrets\/)?([^}/]+)\}$/);
        if (!match || !SECRET_NAME.test(match[2])) return [headerName, headerValue];
        return [headerName, { secret_file: match[2], prefix: match[1] }];
      }));
    }
    if (server.type === "local" && server.environment && typeof server.environment === "object" && !Array.isArray(server.environment)) {
      const secrets = {};
      const literals = {};
      for (const [environmentName, environmentValue] of Object.entries(server.environment)) {
        if (secretName(environmentValue)) secrets[environmentName] = environmentValue;
        else literals[environmentName] = environmentValue;
      }
      server.environment = secrets;
      server.literal_environment = { ...(server.literal_environment ?? {}), ...literals };
    }
    if (Number.isSafeInteger(server.timeout)) {
      server.timeout = { startup: server.timeout, catalog: server.timeout, execution: server.timeout };
    }
    servers[name] = server;
  }
  const legacyPermissions = config.permission ?? {};
  object(legacyPermissions, "legacy permission");
  const migratedPermissions = {};
  for (const [action, effect] of Object.entries(legacyPermissions)) {
    if (action === "read") {
      object(effect, "legacy permission.read");
      if (Object.entries(effect).some(([resource, decision]) => resource !== `${EXTERNAL_MCP_SECRET_ROOT}/*` || decision !== "deny")) {
        invalid("legacy permission.read may only deny the external MCP secrets directory");
      }
      continue;
    }
    migratedPermissions[action] = effect;
  }
  delete config.mcp;
  delete config.permission;
  return { servers, permissions: migratedPermissions };
}

export function prepareExternalMcpConfig(options = {}, legacyDocument = null) {
  let raw = options.external_mcp_config ?? "";
  if (typeof raw !== "string") invalid("the saved option must be a JSON string");
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) invalid("the saved option exceeds 256 KiB");
  if (raw.trim() && legacyDocument) invalid("move legacy mcp and permission fields out of opencode_config before using external_mcp_config");
  if (!raw.trim() && !legacyDocument) return { servers: {}, permissions: [] };
  let document;
  if (legacyDocument) document = legacyDocument;
  else {
    try { document = JSON.parse(raw); }
    catch { invalid("invalid JSON; correct the saved option and restart"); }
  }
  fields(document, ["servers", "permissions"], "root");
  const servers = validateExternalServers(document.servers ?? {});
  return { servers, permissions: permissions(document.permissions, Object.keys(servers)) };
}

export async function readExternalMcpSecret(name, { root = EXTERNAL_MCP_SECRET_ROOT } = {}) {
  if (!SECRET_NAME.test(name)) throw new TypeError("External MCP secret name is invalid");
  let directory;
  let handle;
  try {
    directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const directoryStat = await directory.stat();
    if (!directoryStat.isDirectory() || directoryStat.uid !== 0 || directoryStat.gid !== 0 || (directoryStat.mode & 0o7777) !== 0o700) throw new Error();
    handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_SECRET_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used === 0 || used > MAX_SECRET_BYTES) throw new Error();
    const value = bytes.subarray(0, used).toString("utf8").replace(/\r?\n$/, "");
    if (!value || /[\r\n\0]/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error("External MCP secret is missing or invalid; check the configured file in the MCP secrets directory");
  } finally {
    await handle?.close();
    await directory?.close();
  }
}

async function resolveValue(value, readSecret) {
  const name = secretName(value);
  return name ? readSecret(name) : value;
}

async function resolveHeaderValue(value, readSecret) {
  if (typeof value === "string") return value;
  return `${value.prefix}${await readSecret(value.secret_file)}`;
}

export async function resolveExternalServers(value, { readSecret = readExternalMcpSecret } = {}) {
  const servers = validateExternalServers(value);
  const resolved = {};
  for (const [index, [name, server]] of Object.entries(servers).entries()) {
    if (!server.enabled) continue;
    if (server.type === "remote") {
      resolved[name] = {
        type: "remote",
        url: server.url,
        headers: Object.fromEntries(await Promise.all(Object.entries(server.headers).map(async ([key, item]) => [key, await resolveHeaderValue(item, readSecret)]))),
        oauth: false,
        disabled: false,
        codemode: false,
        ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
      };
    } else {
      const environment = {
        ...server.literal_environment,
        ...Object.fromEntries(await Promise.all(Object.entries(server.environment).map(async ([key, item]) => [key, await resolveValue(item, readSecret)]))),
      };
      const environmentNames = Object.keys(environment).sort();
      resolved[name] = {
        type: "local",
        command: [EXTERNAL_MCP_LAUNCHER, String(EXTERNAL_MCP_UID_BASE + index), String(environmentNames.length), ...environmentNames, ...server.command],
        environment,
        disabled: false,
        codemode: false,
        ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
      };
    }
  }
  return resolved;
}
