import { createHash, createHmac, randomBytes } from "crypto";
import WebSocket from "ws";

export const MAX_ESPHOME_CONFIG_BYTES = 1024 * 1024;

const SECRET_ARGUMENT_FIELDS = new Set([
  "api_key",
  "encryption",
  "key",
  "pairing_key",
  "password",
  "psk",
  "token",
  "value",
]);

export class DeviceBuilderCommandError extends Error {
  constructor(command, code, details = "") {
    super(`ESPHome Device Builder rejected ${command} (${code})`);
    this.name = "DeviceBuilderCommandError";
    this.command = command;
    this.code = code;
    this.details = details;
  }
}

export function buildDeviceBuilderWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ESPHome Device Builder URL must use HTTP or HTTPS");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class ESPHomeDeviceBuilderClient {
  constructor({ baseUrl, ingressSession = "", token = "", timeoutMs = 30000, WebSocketImpl = WebSocket }) {
    this.url = buildDeviceBuilderWebSocketUrl(baseUrl);
    this.ingressSession = ingressSession;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.nextMessageId = 1;
  }

  command(command, args = {}) {
    const messageId = String(this.nextMessageId++);
    const headers = {};
    if (this.ingressSession) headers.Cookie = `ingress_session=${this.ingressSession}`;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url, { headers });
      let settled = false;
      let commandSent = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (ws.readyState === this.WebSocketImpl.OPEN) {
          ws.close();
        } else if (ws.readyState !== this.WebSocketImpl.CLOSED && typeof ws.terminate === "function") {
          ws.terminate();
        }
        callback(value);
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error(`ESPHome Device Builder command ${command} timed out`));
      }, this.timeoutMs);

      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        const error = new Error(`ESPHome Device Builder WebSocket handshake failed with HTTP ${response.statusCode}`);
        error.statusCode = response.statusCode;
        finish(reject, error);
      });

      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          finish(reject, new Error("ESPHome Device Builder returned invalid JSON"));
          return;
        }

        if (!commandSent && Object.hasOwn(message, "server_version")) {
          if (message.requires_auth) {
            finish(reject, new Error("ESPHome Device Builder did not accept the Home Assistant ingress session"));
            return;
          }
          commandSent = true;
          ws.send(JSON.stringify({ command, message_id: messageId, args }));
          return;
        }

        if (message.message_id !== messageId) return;
        if (message.error_code) {
          finish(reject, new DeviceBuilderCommandError(command, message.error_code, message.details));
          return;
        }
        if (Object.hasOwn(message, "result")) finish(resolve, message.result);
      });

      ws.on("error", (error) => finish(reject, new Error(`ESPHome Device Builder WebSocket error: ${error.message}`)));
      ws.on("close", () => {
        if (!settled) finish(reject, new Error(`ESPHome Device Builder closed before ${command} completed`));
      });
    });
  }

  stream(command, args = {}, {
    timeoutMs = this.timeoutMs,
    maxEvents = 500,
    maxChars = 50000,
    stopCommand = "",
    stopGraceMs = 2000,
  } = {}) {
    const messageId = String(this.nextMessageId++);
    const stopMessageId = `${messageId}-stop`;
    const headers = {};
    if (this.ingressSession) headers.Cookie = `ingress_session=${this.ingressSession}`;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url, { headers });
      const events = [];
      let settled = false;
      let commandSent = false;
      let stopRequested = false;
      let stopReason = "";
      let eventChars = 0;
      let stopTimer = null;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (stopTimer) clearTimeout(stopTimer);
        if (ws.readyState === this.WebSocketImpl.OPEN) {
          ws.close();
        } else if (ws.readyState !== this.WebSocketImpl.CLOSED && typeof ws.terminate === "function") {
          ws.terminate();
        }
        callback(value);
      };

      const finishStream = (result = null, truncated = false) => finish(resolve, {
        result,
        events,
        truncated,
        stopReason,
      });

      const requestStop = (reason) => {
        if (settled || stopRequested) return;
        stopRequested = true;
        stopReason = reason;
        if (!stopCommand || !commandSent || ws.readyState !== this.WebSocketImpl.OPEN) {
          finishStream(null, true);
          return;
        }
        ws.send(JSON.stringify({
          command: stopCommand,
          message_id: stopMessageId,
          args: { stream_id: messageId },
        }));
        stopTimer = setTimeout(() => finishStream(null, true), stopGraceMs);
      };

      const timeout = setTimeout(() => requestStop("timeout"), timeoutMs);

      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        const error = new Error(`ESPHome Device Builder WebSocket handshake failed with HTTP ${response.statusCode}`);
        error.statusCode = response.statusCode;
        finish(reject, error);
      });

      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          finish(reject, new Error("ESPHome Device Builder returned invalid JSON"));
          return;
        }

        if (!commandSent && Object.hasOwn(message, "server_version")) {
          if (message.requires_auth) {
            finish(reject, new Error("ESPHome Device Builder did not accept the Home Assistant ingress session"));
            return;
          }
          commandSent = true;
          ws.send(JSON.stringify({ command, message_id: messageId, args }));
          return;
        }

        if (message.message_id === stopMessageId) {
          if (message.error_code) {
            finish(reject, new DeviceBuilderCommandError(stopCommand, message.error_code, message.details));
          } else if (Object.hasOwn(message, "result")) {
            finishStream(null, true);
          }
          return;
        }

        if (message.message_id !== messageId) return;
        if (message.error_code) {
          finish(reject, new DeviceBuilderCommandError(command, message.error_code, message.details));
          return;
        }
        if (Object.hasOwn(message, "event")) {
          const serialized = typeof message.data === "string" ? message.data : JSON.stringify(message.data ?? null);
          if (events.length >= maxEvents || eventChars + serialized.length > maxChars) {
            requestStop(events.length >= maxEvents ? "event_limit" : "character_limit");
            return;
          }
          events.push({ event: message.event, data: message.data });
          eventChars += serialized.length;
          return;
        }
        if (Object.hasOwn(message, "result")) finishStream(message.result, stopRequested);
      });

      ws.on("error", (error) => finish(reject, new Error(`ESPHome Device Builder WebSocket error: ${error.message}`)));
      ws.on("close", () => {
        if (!settled) finish(reject, new Error(`ESPHome Device Builder closed before ${command} completed`));
      });
    });
  }

}

export function redactESPHomeToolArgs(name, args) {
  if (!name?.startsWith("esphome_") || !args || typeof args !== "object") return args;

  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    const safe = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (field === "content" || field === "file_content") {
        safe[`${field}_chars`] = typeof fieldValue === "string" ? fieldValue.length : null;
      } else if (field === "ssid") {
        safe.has_ssid = Boolean(fieldValue);
      } else if (field === "query") {
        safe.query_chars = typeof fieldValue === "string" ? fieldValue.length : null;
      } else if (SECRET_ARGUMENT_FIELDS.has(field)) {
        safe[`has_${field}`] = Boolean(fieldValue);
      } else {
        safe[field] = redact(fieldValue);
      }
    }
    return safe;
  };

  return redact(args);
}

export function sha256Text(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const SENSITIVE_PLACEHOLDER_RE = /__OPENCODE_SECRET_[a-f0-9]{12}_\d+__/g;
const SENSITIVE_PLACEHOLDER_LINE_RE = /__OPENCODE_SECRET_[a-f0-9]{12}_\d+__/;
const CANONICAL_32_BYTE_BASE64_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g;
const SENSITIVE_FIELD_NAME = "(?:password|psk|token|api_key|client_secret|encryption_key|[\\w.-]+_(?:password|token|secret))";
const SENSITIVE_YAML_FIELD_RE = new RegExp(`^(\\s*${SENSITIVE_FIELD_NAME}\\s*:\\s*)(.*)$`, "i");
const FLOW_SENSITIVE_KEY = `(?:\"${SENSITIVE_FIELD_NAME}\"|'${SENSITIVE_FIELD_NAME}'|${SENSITIVE_FIELD_NAME})`;
const FLOW_SENSITIVE_FIELD_RE = new RegExp(`(${FLOW_SENSITIVE_KEY}\\s*:\\s*)(\"(?:\\\\.|[^\"])*\"|'(?:''|[^'])*'|[^,}\\]]+)`, "gi");
const PLACEHOLDER_HMAC_KEY = randomBytes(32);

export function maskESPHomeSensitiveText(content) {
  if (typeof content !== "string") return { content, replacements: new Map() };
  const replacements = new Map();
  const sensitiveSubstitutions = new Set();
  const substitutionDefinitions = new Map();
  const collectReferences = (value) => {
    for (const match of value.matchAll(/\$(?:\{([^}]+)\}|([A-Za-z_]\w*))/g)) {
      sensitiveSubstitutions.add(match[1] || match[2]);
    }
  };
  for (const line of content.split(/\r?\n/)) {
    const definition = line.match(/^\s*([^\s:#][^:]*)\s*:\s*(.*)$/);
    if (definition) substitutionDefinitions.set(definition[1].trim(), definition[2]);
    const direct = line.match(SENSITIVE_YAML_FIELD_RE);
    if (direct) collectReferences(direct[2]);
    for (const flow of line.matchAll(FLOW_SENSITIVE_FIELD_RE)) {
      collectReferences(flow[2]);
    }
  }
  let previousSize = -1;
  while (previousSize !== sensitiveSubstitutions.size) {
    previousSize = sensitiveSubstitutions.size;
    for (const name of [...sensitiveSubstitutions]) {
      const definition = substitutionDefinitions.get(name);
      if (definition) collectReferences(definition);
    }
  }
  let occurrence = 0;
  const placeholderFor = (value) => {
    const index = occurrence++;
    const id = createHmac("sha256", PLACEHOLDER_HMAC_KEY).update(String(index)).digest("hex").slice(0, 12);
    const placeholder = `__OPENCODE_SECRET_${id}_${index}__`;
    replacements.set(placeholder, value);
    return placeholder;
  };

  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  for (let index = 0; index < lines.length; index += 1) {
    const newline = lines[index].endsWith("\r\n") ? "\r\n" : lines[index].endsWith("\n") ? "\n" : "";
    const body = newline ? lines[index].slice(0, -newline.length) : lines[index];
    const substitutionField = body.match(/^(\s*([^\s:#][^:]*)\s*:\s*)(.*)$/);
    const sensitiveField = substitutionField && sensitiveSubstitutions.has(substitutionField[2].trim())
      ? [substitutionField[0], substitutionField[1], substitutionField[3]]
      : body.match(SENSITIVE_YAML_FIELD_RE);
    if (sensitiveField) {
      const value = sensitiveField[2].trim();
      if (value && !value.startsWith("!secret") && !value.startsWith("${")) {
        lines[index] = `${sensitiveField[1]}${placeholderFor(sensitiveField[2])}${newline}`;
        const baseIndent = sensitiveField[1].match(/^\s*/)[0].length;
        for (let child = index + 1; child < lines.length; child += 1) {
          const childNewline = lines[child].endsWith("\r\n") ? "\r\n" : lines[child].endsWith("\n") ? "\n" : "";
          const childBody = childNewline ? lines[child].slice(0, -childNewline.length) : lines[child];
          if (!childBody.trim()) continue;
          const childIndent = childBody.match(/^\s*/)[0].length;
          if (childIndent <= baseIndent) break;
          const indentation = childBody.slice(0, childIndent);
          lines[child] = `${indentation}${placeholderFor(childBody.slice(childIndent))}${childNewline}`;
        }
        continue;
      }
    }
    const flowMasked = body.replace(FLOW_SENSITIVE_FIELD_RE, (match, prefix, value) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed.startsWith("!secret") || trimmed.startsWith("${")) return match;
      return `${prefix}${placeholderFor(value)}`;
    });
    lines[index] = flowMasked.replace(CANONICAL_32_BYTE_BASE64_RE, (value) => placeholderFor(value)) + newline;
  }
  const masked = lines.join("");
  return { content: masked, replacements };
}

function hasSensitivePlaceholderInFlowCollection(content) {
  let depth = 0;
  for (const line of String(content).split(/\r?\n/)) {
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "[" || char === "{") depth += 1;
      if (SENSITIVE_PLACEHOLDER_LINE_RE.test(line.slice(index)) && depth > 0) return true;
      if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

function sensitivePlaceholderLocations(content) {
  const locations = new Map();
  const stack = [];
  const sequenceCounters = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indentation = line.match(/^\s*/)[0].length;
    while (stack.length && stack.at(-1).indent >= indentation) stack.pop();
    const sequenceMatch = line.match(/^\s*-\s*(.*)$/);
    let keySource = line;
    if (sequenceMatch) {
      const parentPath = stack.map((item) => item.key).join(".");
      const counterKey = `${parentPath}:${indentation}`;
      const sequenceIndex = sequenceCounters.get(counterKey) ?? 0;
      sequenceCounters.set(counterKey, sequenceIndex + 1);
      stack.push({ indent: indentation, key: `[${sequenceIndex}]` });
      keySource = `${" ".repeat(indentation + 2)}${sequenceMatch[1]}`;
    }
    const keyMatch = keySource.match(/^\s*([^\s#][^:]*):(?:\s|$)/);
    const currentPath = keyMatch ? [...stack.map((item) => item.key), keyMatch[1].trim()] : stack.map((item) => item.key);
    for (const placeholder of line.match(SENSITIVE_PLACEHOLDER_RE) ?? []) {
      locations.set(placeholder, currentPath.join("."));
    }
    if (keyMatch) stack.push({ indent: indentation + (sequenceMatch ? 2 : 0), key: keyMatch[1].trim() });
  }
  return locations;
}

export function restoreESPHomeSensitivePlaceholders(candidate, original) {
  const masked = maskESPHomeSensitiveText(original);
  if (hasSensitivePlaceholderInFlowCollection(masked.content)) {
    throw new Error("Sensitive values inside flow-style YAML collections cannot be edited safely; convert them to block YAML first");
  }
  const expectedOrder = [...masked.replacements.keys()];
  const actualOrder = candidate.match(SENSITIVE_PLACEHOLDER_RE) ?? [];
  if (actualOrder.length !== expectedOrder.length || actualOrder.some((item, index) => item !== expectedOrder[index])) {
    throw new Error("Sensitive placeholders must remain present and in their original order");
  }
  const expectedLocations = sensitivePlaceholderLocations(masked.content);
  const actualLocations = sensitivePlaceholderLocations(candidate);
  for (const placeholder of expectedOrder) {
    if (expectedLocations.get(placeholder) !== actualLocations.get(placeholder)) {
      throw new Error(`Sensitive placeholder ${placeholder} must remain at ${expectedLocations.get(placeholder) || "its original YAML location"}`);
    }
  }
  let restored = candidate;
  for (const [placeholder, value] of masked.replacements) {
    const matches = restored.split(placeholder).length - 1;
    if (matches !== 1) {
      throw new Error(`Sensitive placeholder ${placeholder} must be preserved exactly once`);
    }
    restored = restored.replace(placeholder, value);
  }
  const unknown = restored.match(SENSITIVE_PLACEHOLDER_RE);
  if (unknown) throw new Error(`Unknown sensitive placeholder: ${unknown[0]}`);
  return restored;
}

export function redactESPHomeSensitiveText(content) {
  const masked = maskESPHomeSensitiveText(String(content ?? ""));
  let redacted = masked.content;
  for (const placeholder of masked.replacements.keys()) redacted = redacted.replace(placeholder, "<redacted>");
  return redacted;
}

export function sanitizeESPHomeResult(value, knownSecretValues = []) {
  if (typeof value === "string") {
    let result = redactESPHomeSensitiveText(value);
    for (const secret of [...knownSecretValues].sort((a, b) => b.length - a.length)) {
      if (secret) result = result.split(secret).join("<redacted>");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeESPHomeResult(item, knownSecretValues));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SECRET_ARGUMENT_FIELDS.has(key) && item) return [key, "<redacted>"];
    return [key, sanitizeESPHomeResult(item, knownSecretValues)];
  }));
}

export function validateConfigurationFilename(configuration) {
  if (typeof configuration !== "string" || configuration !== configuration.trim() || !configuration) {
    throw new Error("configuration must be a non-empty filename");
  }
  if (configuration.includes("/") || configuration.includes("\\") || configuration.includes("\0")) {
    throw new Error("configuration must be a filename, not a path");
  }
  if (!/\.ya?ml$/i.test(configuration)) {
    throw new Error("configuration must end with .yaml or .yml");
  }
  if (configuration.toLowerCase() === "secrets.yaml") {
    throw new Error("secrets.yaml is intentionally unavailable through ESPHome source tools");
  }
  return configuration;
}

function validateSourceContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("content must be non-empty YAML text");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ESPHOME_CONFIG_BYTES) {
    throw new Error(`ESPHome configuration is too large (${bytes} bytes; maximum ${MAX_ESPHOME_CONFIG_BYTES})`);
  }
  return bytes;
}

function configuredDevices(result) {
  return Array.isArray(result?.configured) ? result.configured : [];
}

async function requireConfiguredDevice(client, configuration) {
  const devices = await client.command("devices/list");
  const device = configuredDevices(devices).find((item) => item?.configuration === configuration);
  if (!device) throw new Error(`ESPHome configuration ${configuration} is not an active configured device`);
  return device;
}

async function readSource(client, configuration) {
  const content = await client.command("devices/get_config", { configuration });
  if (typeof content !== "string") throw new Error("ESPHome Device Builder returned a non-text configuration");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ESPHOME_CONFIG_BYTES) {
    throw new Error(`ESPHome configuration is too large (${bytes} bytes; maximum ${MAX_ESPHOME_CONFIG_BYTES})`);
  }
  return { content, bytes, sha256: sha256Text(content) };
}

export async function readESPHomeConfig(client, configuration) {
  configuration = validateConfigurationFilename(configuration);
  const device = await requireConfiguredDevice(client, configuration);
  const source = await readSource(client, configuration);
  const masked = maskESPHomeSensitiveText(source.content);
  return {
    configuration,
    device,
    content: masked.content,
    bytes: source.bytes,
    sha256: source.sha256,
    sensitive_values_masked: masked.replacements.size,
  };
}

export function normalizeESPHomeValidation(result) {
  const yamlErrors = Array.isArray(result?.yaml_errors) ? result.yaml_errors : [];
  const validationErrors = Array.isArray(result?.validation_errors) ? result.validation_errors : [];
  return {
    valid: yamlErrors.length === 0 && validationErrors.length === 0,
    yaml_errors: yamlErrors,
    validation_errors: validationErrors,
  };
}

export async function validateESPHomeConfig(client, configuration, content, { requireConfigured = true } = {}) {
  configuration = validateConfigurationFilename(configuration);
  const bytes = validateSourceContent(content);
  if (requireConfigured) {
    await requireConfiguredDevice(client, configuration);
    const original = await readSource(client, configuration);
    content = restoreESPHomeSensitivePlaceholders(content, original.content);
  }
  const result = await client.command("editor/validate_yaml", { configuration, content });
  return {
    configuration,
    bytes,
    sha256: sha256Text(content),
    ...normalizeESPHomeValidation(result),
  };
}

export async function updateESPHomeConfig(client, {
  configuration,
  content,
  expectedSha256,
  apply = false,
}) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("expected_sha256 must be the SHA-256 returned by esphome_config_read");
  }
  const original = await readESPHomeConfig(client, configuration);
  if (original.sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`ESPHome configuration ${configuration} changed since it was read; read it again before updating`);
  }

  const rawOriginal = await readSource(client, configuration);
  content = restoreESPHomeSensitivePlaceholders(content, rawOriginal.content);
  const validation = await validateESPHomeConfig(client, configuration, content, { requireConfigured: false });
  const noChanges = validation.sha256 === original.sha256;
  if (!validation.valid || !apply || noChanges) {
    return {
      ...validation,
      applied: false,
      no_changes: noChanges,
      ready_to_apply: validation.valid && !noChanges,
      concurrency_guard: "best_effort_hash_check",
    };
  }

  const latest = await readSource(client, configuration);
  if (latest.sha256 !== original.sha256) {
    throw new Error(`ESPHome configuration ${configuration} changed during validation; no update was applied`);
  }

  try {
    await client.command("devices/update_config", { configuration, content });
  } catch (error) {
    const current = await readSource(client, configuration).catch(() => null);
    if (current?.sha256 === validation.sha256) {
      throw new Error(`${error.message}; the write completed, so read the configuration before any recovery action`);
    }
    if (!current) throw new Error(`${error.message}; write state is unknown, so read the configuration before retrying`);
    if (current.sha256 !== original.sha256) {
      throw new Error(`${error.message}; source changed concurrently and automatic recovery was not attempted`);
    }
    throw error;
  }

  let persisted;
  try {
    persisted = await readSource(client, configuration);
  } catch (error) {
    throw new Error(`ESPHome write completed but read-back failed: ${error.message}; read the configuration before retrying`);
  }
  if (persisted.sha256 !== validation.sha256) {
    throw new Error("ESPHome source changed concurrently after the write; automatic recovery was not attempted");
  }

  let persistedValidation;
  try {
    persistedValidation = await validateESPHomeConfig(client, configuration, persisted.content, { requireConfigured: false });
  } catch (error) {
    throw new Error(`ESPHome write completed but persisted validation could not complete: ${error.message}; the new source was left in place`);
  }
  if (!persistedValidation.valid) {
    return {
      ...persistedValidation,
      applied: true,
      post_write_validation_failed: true,
      manual_recovery_required: true,
      previous_sha256: original.sha256,
      ready_to_apply: false,
    };
  }

  return {
    ...persistedValidation,
    applied: true,
    no_changes: false,
    ready_to_apply: false,
    previous_sha256: original.sha256,
    concurrency_guard: "best_effort_hash_check",
  };
}

function validateCreateName(name) {
  if (typeof name !== "string" || !/^[a-z0-9_](?:[a-z0-9_-]{0,29}[a-z0-9_])?$/.test(name)) {
    throw new Error("name must be a lowercase ESPHome hostname of at most 31 characters");
  }
  return name;
}

export async function createESPHomeConfig(client, {
  name,
  friendlyName,
  boardId,
  content,
  ssid,
  psk,
  apply = false,
}) {
  name = validateCreateName(name);
  const configuration = `${name}.yaml`;
  if (content && boardId) throw new Error("content and board_id are mutually exclusive");
  if (content && (ssid || psk)) throw new Error("ssid and psk cannot be combined with caller-supplied content");
  if (psk && !ssid) throw new Error("psk requires ssid");
  if (content !== undefined) validateSourceContent(content);

  const devices = await client.command("devices/list");
  if (configuredDevices(devices).some((item) => item?.configuration === configuration)) {
    throw new Error(`ESPHome configuration ${configuration} already exists`);
  }
  if (boardId) {
    const board = await client.command("boards/get_board", { board_id: boardId });
    if (!board) throw new Error(`Unknown ESPHome board_id: ${boardId}`);
  }

  let validation = null;
  if (content !== undefined) {
    validation = await validateESPHomeConfig(client, configuration, content, { requireConfigured: false });
    if (!validation.valid) return { ...validation, created: false, ready_to_apply: false };
  }
  if (!apply) {
    return {
      configuration,
      created: false,
      ready_to_apply: true,
      validation: validation ?? { valid: null, deferred_to_device_builder: true },
    };
  }

  const args = { name, overwrite: false };
  if (friendlyName) args.friendly_name = friendlyName;
  if (boardId) args.board_id = boardId;
  if (content !== undefined) args.file_content = content;
  if (ssid) args.ssid = ssid;
  if (psk) args.psk = psk;
  let result;
  try {
    result = await client.command("devices/create", args);
  } catch (error) {
    const afterFailure = await client.command("devices/list").catch(() => null);
    const exists = configuredDevices(afterFailure).some((item) => item?.configuration === configuration);
    if (exists) {
      throw new Error(`${error.message}; ${configuration} now exists, so inspect it before retrying`);
    }
    throw error;
  }
  const createdConfiguration = result?.configuration || configuration;

  if (content === undefined) {
    return {
      configuration: createdConfiguration,
      created: true,
      warning: result?.warning ?? null,
      validation: { valid: true, performed_by_device_builder: true },
    };
  }

  let source;
  try {
    source = await readSource(client, createdConfiguration);
  } catch (error) {
    throw new Error(`Created ${createdConfiguration} but could not verify it: ${error.message}; inspect it before retrying`);
  }

  if (content !== undefined) {
    let persistedValidation;
    try {
      persistedValidation = await validateESPHomeConfig(client, createdConfiguration, source.content, { requireConfigured: false });
    } catch (error) {
      return {
        configuration: createdConfiguration,
        created: true,
        bytes: source.bytes,
        sha256: source.sha256,
        post_write_validation_unavailable: true,
        manual_verification_required: true,
        error: error.message,
      };
    }
    if (!persistedValidation.valid) {
      return {
        ...persistedValidation,
        created: true,
        post_write_validation_failed: true,
        manual_recovery_required: true,
        ready_to_apply: false,
      };
    }
  }

  return {
    configuration: createdConfiguration,
    created: true,
    bytes: source.bytes,
    sha256: source.sha256,
    warning: result?.warning ?? null,
  };
}
