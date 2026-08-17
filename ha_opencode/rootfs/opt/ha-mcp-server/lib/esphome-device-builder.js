import { createHash } from "crypto";
import WebSocket from "ws";

export const MAX_ESPHOME_CONFIG_BYTES = 1024 * 1024;

const SOURCE_TOOL_NAMES = new Set([
  "esphome_config_read",
  "esphome_config_validate",
  "esphome_config_update",
  "esphome_config_create",
]);

export class DeviceBuilderCommandError extends Error {
  constructor(command, code, details = "") {
    const suffix = details ? `: ${String(details).replace(/\s+/g, " ").slice(0, 500)}` : "";
    super(`ESPHome Device Builder rejected ${command} (${code})${suffix}`);
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
}

export function redactESPHomeToolArgs(name, args) {
  if (!SOURCE_TOOL_NAMES.has(name) || !args || typeof args !== "object") return args;
  const safe = { ...args };
  if (Object.hasOwn(safe, "content")) {
    safe.content_chars = typeof safe.content === "string" ? safe.content.length : null;
    delete safe.content;
  }
  if (Object.hasOwn(safe, "ssid")) {
    safe.has_ssid = Boolean(safe.ssid);
    delete safe.ssid;
  }
  if (Object.hasOwn(safe, "psk")) {
    safe.has_psk = Boolean(safe.psk);
    delete safe.psk;
  }
  return safe;
}

export function sha256Text(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateConfigurationFilename(configuration) {
  if (typeof configuration !== "string" || configuration !== configuration.trim() || !configuration) {
    throw new Error("configuration must be a non-empty filename");
  }
  if (configuration.includes("/") || configuration.includes("\\") || configuration.includes("\0")) {
    throw new Error("configuration must be a filename, not a path");
  }
  if (!configuration.toLowerCase().endsWith(".yaml")) {
    throw new Error("configuration must end with .yaml");
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
  return { configuration, device, ...source };
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
  if (requireConfigured) await requireConfiguredDevice(client, configuration);
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
