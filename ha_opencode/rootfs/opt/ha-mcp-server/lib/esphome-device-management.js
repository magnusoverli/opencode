import {
  DeviceBuilderCommandError,
  MAX_ESPHOME_CONFIG_BYTES,
  maskESPHomeSensitiveText,
  normalizeESPHomeValidation,
  redactESPHomeSensitiveText,
  restoreESPHomeSensitivePlaceholders,
  sanitizeESPHomeResult,
  sha256Text,
  validateConfigurationFilename,
} from "./esphome-device-builder.js";
import { parse as parseYaml } from "yaml";

const MAX_HISTORY_TEXT_CHARS = 100000;
const MAX_JOB_OUTPUT_LINES = 200;
const MAX_JOB_OUTPUT_CHARS = 50000;

function collectScalarValues(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) collectScalarValues(item, target);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectScalarValues(item, target);
  } else if (value !== null && value !== undefined && String(value)) {
    const text = String(value);
    target.add(text);
    for (const line of text.split(/\r?\n/)) if (line) target.add(line);
  }
}

export async function sanitizeESPHomeResultWithSecrets(client, result) {
  let content = "";
  try {
    content = await client.command("devices/get_config", { configuration: "secrets.yaml" });
  } catch (error) {
    if (!(error instanceof DeviceBuilderCommandError && error.code === "not_found")) {
      throw new Error(`ESPHome output was withheld because secrets could not be loaded for redaction: ${redactESPHomeSensitiveText(error.message)}`);
    }
  }
  const values = new Set();
  if (content) {
    let parsed;
    try {
      parsed = parseYaml(content);
    } catch {
      throw new Error("ESPHome output was withheld because secrets.yaml could not be parsed for redaction");
    }
    collectScalarValues(parsed, values);
  }
  return sanitizeESPHomeResult(result, values);
}

function configuredDevices(result) {
  return Array.isArray(result?.configured) ? result.configured : [];
}

function importableDevices(result) {
  return Array.isArray(result?.importable) ? result.importable : [];
}

async function listDevices(client) {
  return client.command("devices/list");
}

async function requireConfiguredDevice(client, configuration) {
  configuration = validateConfigurationFilename(configuration);
  const devices = await listDevices(client);
  const device = configuredDevices(devices).find((item) => item?.configuration === configuration);
  if (!device) throw new Error(`ESPHome configuration ${configuration} is not an active configured device`);
  return device;
}

function validateHostname(name, field = "new_name") {
  if (typeof name !== "string" || !/^[a-z0-9_](?:[a-z0-9_-]{0,29}[a-z0-9_])?$/.test(name)) {
    throw new Error(`${field} must be a lowercase ESPHome hostname of at most 31 characters`);
  }
  return name;
}

export function validateESPHomeContainedPath(filePath, { allowSecrets = false } = {}) {
  if (typeof filePath !== "string" || filePath !== filePath.trim() || !filePath) {
    throw new Error("path must be a non-empty config-root-relative path");
  }
  if (filePath.includes("\0") || filePath.includes("\\") || filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
    throw new Error("path must be a config-root-relative POSIX path");
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("path cannot contain empty, current-directory, or parent-directory segments");
  }
  if (!/\.ya?ml$/i.test(filePath)) throw new Error("path must end with .yaml or .yml");
  if (!allowSecrets && segments.at(-1).toLowerCase() === "secrets.yaml") {
    throw new Error("Use esphome_secrets for secrets.yaml");
  }
  return filePath;
}

function validateTextContent(content, { allowEmpty = false } = {}) {
  if (typeof content !== "string" || (!allowEmpty && !content.trim())) {
    throw new Error(allowEmpty ? "content must be text" : "content must be non-empty YAML text");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ESPHOME_CONFIG_BYTES) {
    throw new Error(`ESPHome file is too large (${bytes} bytes; maximum ${MAX_ESPHOME_CONFIG_BYTES})`);
  }
  return bytes;
}

async function readFile(client, filePath) {
  const content = await client.command("devices/get_config", { configuration: filePath });
  if (typeof content !== "string") throw new Error("ESPHome Device Builder returned non-text file content");
  const bytes = validateTextContent(content, { allowEmpty: true });
  return { path: filePath, content, bytes, sha256: sha256Text(content) };
}

async function assertSeparateFromSecrets(client, filePath, source) {
  let secrets;
  try {
    secrets = await readFile(client, "secrets.yaml");
  } catch (error) {
    if (!(error instanceof DeviceBuilderCommandError && error.code === "not_found")) {
      throw new Error(`Could not verify that ${filePath} is separate from secrets.yaml: ${error.message}`);
    }
  }
  if (secrets?.sha256 === source.sha256) {
    throw new Error(`${filePath} resolves to, or duplicates, secrets.yaml and cannot be managed through this tool`);
  }
}

function requireExpectedHash(expectedSha256, actualSha256, filePath) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("expected_sha256 must be a 64-character SHA-256 from the corresponding read operation");
  }
  if (expectedSha256.toLowerCase() !== actualSha256) {
    throw new Error(`${filePath} changed since it was read; read it again before applying`);
  }
}

async function affectedConfigurations(client, query) {
  const result = await client.command("yaml/search", {
    query,
    max_results: 100,
    case_sensitive: true,
    context_lines: 0,
  });
  return [...new Set((Array.isArray(result) ? result : []).map((item) => item?.configuration).filter(Boolean))];
}

async function validatePersistedDevices(client, configurations) {
  const results = [];
  for (const configuration of configurations.slice(0, 25)) {
    try {
      const source = await readFile(client, configuration);
      const raw = await client.command("editor/validate_yaml", { configuration, content: source.content });
      results.push({ configuration, ...normalizeESPHomeValidation(raw) });
    } catch (error) {
      results.push({ configuration, valid: false, error: error.message });
    }
  }
  return {
    results,
    truncated: configurations.length > 25,
    all_valid: configurations.length <= 25 && results.every((item) => item.valid),
    coverage: "direct_top_level_references_only",
  };
}

export async function listESPHomeBoards(client, {
  query,
  platform,
  variant,
  mcu,
  tag,
  offset = 0,
  limit = 50,
} = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  const args = { offset, limit };
  if (query) args.query = query;
  if (platform) args.platform = platform;
  if (variant) args.variant = variant;
  if (mcu) args.mcu = mcu;
  if (tag) args.tag = tag;
  return client.command("boards/get_boards", args);
}

export async function searchESPHomeYaml(client, {
  query,
  maxResults = 50,
  caseSensitive = false,
  contextLines = 2,
}) {
  if (typeof query !== "string" || !query.trim()) throw new Error("query must be non-empty");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new Error("max_results must be between 1 and 200");
  }
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) {
    throw new Error("context_lines must be between 0 and 10");
  }
  const result = await client.command("yaml/search", {
    query,
    max_results: maxResults,
    case_sensitive: Boolean(caseSensitive),
    context_lines: contextLines,
  });
  const results = (Array.isArray(result) ? result : []).map((entry) => ({
    ...entry,
    matches: (Array.isArray(entry?.matches) ? entry.matches : []).map((match) => ({
      ...match,
      line_text: redactESPHomeSensitiveText(match.line_text),
      before: Array.isArray(match.before) ? match.before.map(redactESPHomeSensitiveText) : [],
      after: Array.isArray(match.after) ? match.after.map(redactESPHomeSensitiveText) : [],
    })),
  }));
  return { query, results };
}

export async function manageESPHomeLifecycle(client, {
  action,
  configuration,
  deviceName,
  newName,
  newFriendlyName,
  ignored,
  generateEncryptionKey = true,
  location = "active",
  expectedSha256,
  confirmation,
  apply = false,
}) {
  if (action === "adopt") {
    if (typeof deviceName !== "string" || !deviceName) throw new Error("device_name is required for adopt");
    const devices = await listDevices(client);
    const matches = importableDevices(devices).filter((item) => item?.name === deviceName);
    if (matches.length !== 1) throw new Error(`Expected exactly one discoverable ESPHome device named ${deviceName}; found ${matches.length}`);
    const candidate = matches[0];
    const preview = {
      action,
      device_name: deviceName,
      project_name: candidate.project_name || "",
      has_package_import_url: Boolean(candidate.package_import_url),
      ready_to_apply: true,
    };
    if (!apply) return { ...preview, applied: false };
    const result = await client.command("devices/import", {
      name: candidate.name,
      project_name: candidate.project_name || "",
      package_import_url: candidate.package_import_url || "",
      friendly_name: candidate.friendly_name || null,
      encryption: generateEncryptionKey ? "generate" : null,
    });
    return { ...preview, applied: true, result };
  }

  if (action === "set_ignored") {
    if (typeof deviceName !== "string" || !deviceName) throw new Error("device_name is required for set_ignored");
    if (typeof ignored !== "boolean") throw new Error("ignored must be true or false");
    if (!apply) return { action, device_name: deviceName, ignored, applied: false, ready_to_apply: true };
    await client.command("devices/ignore", { name: deviceName, ignore: ignored });
    return { action, device_name: deviceName, ignored, applied: true };
  }

  configuration = validateConfigurationFilename(configuration);
  if (location !== "active" && location !== "archived") throw new Error("location must be active or archived");
  if (["clone", "rename", "archive"].includes(action) && location !== "active") {
    throw new Error(`${action} requires location=active`);
  }
  if (action === "unarchive" && location !== "archived") {
    throw new Error("unarchive requires location=archived");
  }
  if (location === "active") {
    await requireConfiguredDevice(client, configuration);
  } else {
    const archived = await client.command("devices/list_archived");
    if (!(Array.isArray(archived) && archived.some((item) => item?.configuration === configuration))) {
      throw new Error(`ESPHome configuration ${configuration} is not archived`);
    }
  }
  const sourcePath = location === "archived" ? `archive/${configuration}` : configuration;
  const source = await readFile(client, sourcePath);

  if (action === "clone" || action === "rename") {
    newName = validateHostname(newName);
    const target = `${newName}.yaml`;
    const devices = await listDevices(client);
    if (configuredDevices(devices).some((item) => item?.configuration === target)) {
      throw new Error(`ESPHome configuration ${target} already exists`);
    }
  }

  const preview = {
    action,
    configuration,
    location,
    current_sha256: source.sha256,
    target_configuration: action === "clone" || action === "rename" ? `${newName}.yaml` : configuration,
    ready_to_apply: true,
    concurrency_guard: "best_effort_hash_check_no_atomic_cas",
  };
  if (!apply) return { ...preview, applied: false };
  requireExpectedHash(expectedSha256, source.sha256, sourcePath);

  const latest = await readFile(client, sourcePath);
  requireExpectedHash(source.sha256, latest.sha256, sourcePath);

  if (action === "clone") {
    const result = await client.command("devices/clone", {
      configuration,
      new_name: newName,
      new_friendly_name: newFriendlyName ?? null,
    });
    return { ...preview, applied: true, result };
  }
  if (action === "rename") {
    const result = await client.command("devices/rename", { configuration, new_name: newName, config_only: true });
    return { ...preview, applied: true, result };
  }
  if (action === "archive") {
    await client.command("devices/archive", { configuration });
    return { ...preview, applied: true };
  }
  if (action === "unarchive") {
    await client.command("devices/unarchive", { configuration });
    return { ...preview, applied: true };
  }
  if (action === "delete") {
    if (confirmation !== `DELETE ${configuration}`) {
      throw new Error(`confirmation must exactly equal DELETE ${configuration}`);
    }
    const command = location === "archived" ? "devices/delete_archived" : "devices/delete";
    await client.command(command, { configuration });
    return { ...preview, applied: true, permanently_deleted: true };
  }
  throw new Error(`Unsupported lifecycle action: ${action}`);
}

export async function manageESPHomeMetadata(client, {
  action,
  configuration,
  friendlyName,
  comment,
  boardId,
  labelIds,
  expectedSha256,
  apply = false,
}) {
  if (action === "list_labels") {
    return { labels: await client.command("labels/list") };
  }
  const device = await requireConfiguredDevice(client, configuration);
  if (action === "get") return { device };

  if (action === "set_friendly_name") {
    if (typeof friendlyName !== "string") throw new Error("friendly_name is required");
    const source = await readFile(client, configuration);
    const preview = { action, configuration, friendly_name: friendlyName, current_sha256: source.sha256 };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    requireExpectedHash(expectedSha256, source.sha256, configuration);
    const result = await client.command("devices/edit_friendly_name", {
      configuration,
      new_friendly_name: friendlyName,
    });
    return { ...preview, applied: true, result };
  }

  if (action === "set_attributes") {
    if (comment === undefined && boardId === undefined) throw new Error("comment and/or board_id is required");
    if (comment !== undefined && typeof comment !== "string") throw new Error("comment must be a string; use an empty string to clear it");
    if (boardId !== undefined && typeof boardId !== "string") throw new Error("board_id must be a string; use an empty string to clear it");
    if (boardId) {
      const board = await client.command("boards/get_board", { board_id: boardId });
      if (!board) throw new Error(`Unknown ESPHome board_id: ${boardId}`);
    }
    const preview = { action, configuration, comment, board_id: boardId };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const args = { configuration };
    if (comment !== undefined) args.comment = comment;
    if (boardId !== undefined) args.board_id = boardId;
    const result = await client.command("devices/update", args);
    return { ...preview, applied: true, result };
  }

  if (action === "set_labels") {
    if (!Array.isArray(labelIds) || labelIds.some((item) => typeof item !== "string")) {
      throw new Error("label_ids must be an array of label ID strings");
    }
    const preview = { action, configuration, label_ids: [...new Set(labelIds)] };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const result = await client.command("devices/set_labels", {
      configuration,
      label_ids: preview.label_ids,
    });
    return { ...preview, applied: true, result };
  }
  throw new Error(`Unsupported metadata action: ${action}`);
}

export async function manageESPHomeFile(client, {
  action,
  filePath,
  content,
  expectedSha256,
  apply = false,
  allowSecrets = false,
  allowWipe = false,
}) {
  filePath = validateESPHomeContainedPath(filePath, { allowSecrets });
  const original = await readFile(client, filePath);
  if (!allowSecrets) await assertSeparateFromSecrets(client, filePath, original);
  if (action === "read") {
    const masked = maskESPHomeSensitiveText(original.content);
    return {
      ...original,
      content: masked.content,
      sensitive_values_masked: masked.replacements.size,
    };
  }
  if (action !== "update") throw new Error(`Unsupported file action: ${action}`);
  if (!allowSecrets) content = restoreESPHomeSensitivePlaceholders(content, original.content);
  validateTextContent(content, { allowEmpty: allowSecrets && allowWipe });
  requireExpectedHash(expectedSha256, original.sha256, filePath);

  const candidateSha256 = sha256Text(content);
  const references = allowSecrets
    ? configuredDevices(await listDevices(client)).map((item) => item.configuration)
    : await affectedConfigurations(client, filePath);
  const preview = {
    action,
    path: filePath,
    current_sha256: original.sha256,
    candidate_sha256: candidateSha256,
    affected_configurations: references,
    validation_deferred_until_after_write: true,
  };
  if (!apply || candidateSha256 === original.sha256) {
    return { ...preview, applied: false, no_changes: candidateSha256 === original.sha256, ready_to_apply: candidateSha256 !== original.sha256 };
  }

  const latest = await readFile(client, filePath);
  requireExpectedHash(original.sha256, latest.sha256, filePath);
  const args = { configuration: filePath, content };
  if (allowSecrets) args.allow_wipe = Boolean(allowWipe);
  await client.command("devices/update_config", args);
  const persisted = await readFile(client, filePath);
  if (persisted.sha256 !== candidateSha256) {
    throw new Error(`${filePath} changed concurrently after the write; automatic recovery was not attempted`);
  }
  const validation = await validatePersistedDevices(client, references);
  return {
    ...preview,
    applied: true,
    persisted_sha256: persisted.sha256,
    post_write_validation: validation,
    manual_recovery_required: !validation.all_valid,
    transitive_include_validation_required: true,
  };
}

export async function manageESPHomeSecrets(client, {
  action,
  key,
  value,
  overwrite = true,
  content,
  expectedSha256,
  allowWipe = false,
  apply = false,
}) {
  if (action === "list") return { keys: await client.command("config/get_secrets") };
  if (action === "fingerprint") {
    const source = await readFile(client, "secrets.yaml");
    return { path: source.path, bytes: source.bytes, sha256: source.sha256, values_redacted: true };
  }
  if (action === "set") {
    if (typeof key !== "string" || !/^[A-Za-z_]\w*$/.test(key)) throw new Error("key must be an identifier-shaped secret name");
    if (typeof value !== "string") throw new Error("value is required");
    const keys = await client.command("config/get_secrets");
    const exists = Array.isArray(keys) && keys.includes(key);
    if (!apply) return { action, key, exists, overwrite, applied: false, ready_to_apply: overwrite || !exists };
    const result = await client.command("config/set_secret", { key, value, overwrite: Boolean(overwrite) });
    return { action, key, existed: exists, applied: true, result };
  }
  if (action === "update") {
    return manageESPHomeFile(client, {
      action: "update",
      filePath: "secrets.yaml",
      content,
      expectedSha256,
      apply,
      allowSecrets: true,
      allowWipe,
    });
  }
  throw new Error(`Unsupported secrets action: ${action}`);
}

function validateApiKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    throw new Error("key must be canonical base64 for exactly 32 bytes");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== key) {
    throw new Error("key must be canonical base64 for exactly 32 bytes");
  }
  return key;
}

export async function manageESPHomeApiKey(client, {
  action,
  configuration,
  secretKey,
  key,
  expectedKeySha256,
  confirmation,
  apply = false,
}) {
  if (action === "status") {
    await requireConfiguredDevice(client, configuration);
    const result = await client.command("devices/get_api_key", { configuration });
    const resolvedKey = typeof result?.key === "string" ? result.key : "";
    return {
      configuration,
      configured: Boolean(resolvedKey),
      key_sha256: resolvedKey ? sha256Text(resolvedKey) : null,
      key_redacted: true,
    };
  }
  if (action === "set_secret") {
    if (typeof secretKey !== "string" || !/^[A-Za-z_]\w*$/.test(secretKey)) {
      throw new Error("secret_key must be an identifier-shaped secrets.yaml key");
    }
    validateApiKey(key);
    const directReferences = await affectedConfigurations(client, `!secret ${secretKey}`);
    const allDevices = configuredDevices(await listDevices(client));
    const fingerprintGroups = new Map();
    for (const device of allDevices) {
      const current = await client.command("devices/get_api_key", { configuration: device.configuration });
      if (!current?.key) continue;
      const fingerprint = sha256Text(current.key);
      if (!fingerprintGroups.has(fingerprint)) fingerprintGroups.set(fingerprint, []);
      fingerprintGroups.get(fingerprint).push(device.configuration);
    }
    const directFingerprints = new Set();
    for (const configuration of directReferences) {
      for (const [fingerprint, configurations] of fingerprintGroups) {
        if (configurations.includes(configuration)) directFingerprints.add(fingerprint);
      }
    }
    const uniqueFingerprints = [...directFingerprints];
    const requestedFingerprint = /^[a-f0-9]{64}$/i.test(expectedKeySha256 || "")
      ? expectedKeySha256.toLowerCase()
      : null;
    const selectedFingerprint = uniqueFingerprints.length === 1
      ? uniqueFingerprints[0]
      : requestedFingerprint && fingerprintGroups.has(requestedFingerprint)
        ? requestedFingerprint
        : null;
    const affected = selectedFingerprint ? fingerprintGroups.get(selectedFingerprint) : directReferences;
    const impactComplete = Boolean(selectedFingerprint)
      && directReferences.every((configuration) => affected.includes(configuration));
    const preview = {
      action,
      secret_key: secretKey,
      direct_reference_configurations: directReferences,
      affected_configurations: affected,
      current_key_sha256: selectedFingerprint,
      consistent_current_key: Boolean(selectedFingerprint),
      impact_complete: impactComplete,
      available_key_groups: [...fingerprintGroups].map(([keySha256, configurations]) => ({
        key_sha256: keySha256,
        configurations,
      })),
    };
    if (!apply) return { ...preview, applied: false, ready_to_apply: impactComplete };
    if (!impactComplete) throw new Error("Select one complete resolved API-key fingerprint group before rotation");
    if (confirmation !== `ROTATE ${secretKey}`) throw new Error(`confirmation must exactly equal ROTATE ${secretKey}`);
    if (selectedFingerprint !== requestedFingerprint) {
      throw new Error("expected_key_sha256 must match the selected current key fingerprint from preview");
    }
    const result = await client.command("config/set_secret", { key: secretKey, value: key, overwrite: true });
    return {
      ...preview,
      applied: true,
      result,
      firmware_reinstall_required: affected,
      home_assistant_key_update_required: true,
    };
  }
  throw new Error(`Unsupported API key action: ${action}`);
}

export async function manageESPHomeHistory(client, {
  action,
  filePath,
  sha,
  expectedSha256,
  revealContent = false,
  apply = false,
}) {
  if (action === "list_deleted") return { deleted: await client.command("version_history/list_deleted") };
  filePath = validateESPHomeContainedPath(filePath);
  if (action === "list") return { path: filePath, versions: await client.command("version_history/list_versions", { configuration: filePath }) };
  if (action === "get") {
    if (!revealContent) throw new Error("reveal_content=true is required to return historical YAML");
    const result = await client.command("version_history/get_version", { configuration: filePath, sha });
    if (typeof result?.content === "string") {
      result.content = maskESPHomeSensitiveText(result.content).content;
    }
    if (typeof result?.content === "string" && result.content.length > MAX_HISTORY_TEXT_CHARS) {
      result.content = result.content.slice(0, MAX_HISTORY_TEXT_CHARS);
      result.truncated = true;
    }
    return result;
  }
  if (action === "diff") {
    const result = await client.command("version_history/get_diff", { configuration: filePath, sha });
    if (typeof result?.diff === "string") result.diff = redactESPHomeSensitiveText(result.diff);
    if (typeof result?.diff === "string" && result.diff.length > MAX_HISTORY_TEXT_CHARS) {
      result.diff = result.diff.slice(0, MAX_HISTORY_TEXT_CHARS);
      result.truncated = true;
    }
    return result;
  }
  if (action === "restore") {
    let current = null;
    try {
      current = await readFile(client, filePath);
    } catch (error) {
      if (!(error instanceof DeviceBuilderCommandError && error.code === "not_found")) throw error;
    }
    if (current) await assertSeparateFromSecrets(client, filePath, current);
    const preview = { action, path: filePath, sha: sha || null, current_sha256: current?.sha256 ?? null };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    if (current) requireExpectedHash(expectedSha256, current.sha256, filePath);
    const args = { configuration: filePath };
    if (sha) args.sha = sha;
    const result = await client.command("version_history/restore", args);
    const restored = await readFile(client, filePath);
    return {
      ...preview,
      applied: true,
      restored_from: result?.restored_from ?? sha ?? null,
      restored_sha256: restored.sha256,
      manual_validation_required: true,
    };
  }
  throw new Error(`Unsupported history action: ${action}`);
}

function boundTextLines(lines, maxLines = MAX_JOB_OUTPUT_LINES, maxChars = MAX_JOB_OUTPUT_CHARS) {
  const source = Array.isArray(lines) ? lines.map(String) : [];
  const selected = source.slice(-maxLines);
  let chars = 0;
  const output = [];
  for (const line of selected) {
    const redacted = redactESPHomeSensitiveText(line);
    if (chars + redacted.length > maxChars) break;
    output.push(redacted);
    chars += redacted.length;
  }
  return { output, truncated: output.length < source.length };
}

export function boundFirmwareJob(job) {
  if (!job || typeof job !== "object") return job;
  const bounded = boundTextLines(job.output);
  return { ...job, output: bounded.output, output_truncated: bounded.truncated };
}

function streamOutput(result) {
  const lines = result.events
    .filter((event) => event.event === "output")
    .map((event) => String(event.data ?? ""));
  const bounded = boundTextLines(lines);
  return {
    output: bounded.output,
    truncated: result.truncated || bounded.truncated,
    stop_reason: result.stopReason,
    terminal: result.events.findLast((event) => event.event === "result")?.data ?? null,
  };
}

export async function manageESPHomeFirmware(client, {
  action,
  configuration,
  jobId,
  status,
  port = "OTA",
  forceLocal = false,
  bootloader = false,
  newName,
  expectedSha256,
  confirmation,
  durationSeconds = 30,
  apply = false,
}) {
  if (action === "status") {
    if (jobId) return { job: boundFirmwareJob(await client.command("firmware/get_job", { job_id: jobId })) };
    const args = {};
    if (status) args.status = status;
    if (configuration) args.configuration = validateConfigurationFilename(configuration);
    const jobs = await client.command("firmware/get_jobs", args);
    return { jobs: (Array.isArray(jobs) ? jobs : []).map(boundFirmwareJob) };
  }
  if (action === "follow") {
    if (typeof jobId !== "string" || !jobId) throw new Error("job_id is required for follow");
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 45) {
      throw new Error("duration_seconds must be between 1 and 45");
    }
    const result = await client.stream("firmware/follow_job", { job_id: jobId }, {
      timeoutMs: durationSeconds * 1000,
      maxEvents: 500,
      maxChars: MAX_JOB_OUTPUT_CHARS,
      stopCommand: "devices/stop_stream",
    });
    return { job_id: jobId, ...streamOutput(result) };
  }
  if (action === "install") {
    await requireConfiguredDevice(client, configuration);
    const preview = { action, configuration, port, force_local: forceLocal, bootloader };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const head = await client.command("firmware/install", {
      configuration,
      port,
      force_local: Boolean(forceLocal),
      bootloader: Boolean(bootloader),
    });
    const jobs = await client.command("firmware/get_jobs", { configuration });
    const chain = (Array.isArray(jobs) ? jobs : []).filter((job) => job.job_id === head?.job_id || job.depends_on === head?.job_id);
    return { ...preview, applied: true, head_job: boundFirmwareJob(head), jobs: chain.map(boundFirmwareJob) };
  }
  if (action === "compile") {
    await requireConfiguredDevice(client, configuration);
    const preview = { action, configuration, force_local: forceLocal };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const job = await client.command("firmware/compile", {
      configuration,
      force_local: Boolean(forceLocal),
    });
    return { ...preview, applied: true, job: boundFirmwareJob(job) };
  }
  if (action === "cancel") {
    if (typeof jobId !== "string" || !jobId) throw new Error("job_id is required for cancel");
    if (!apply) return { action, job_id: jobId, applied: false, ready_to_apply: true };
    await client.command("firmware/cancel", { job_id: jobId });
    return { action, job_id: jobId, applied: true };
  }
  if (action === "clean") {
    await requireConfiguredDevice(client, configuration);
    if (!apply) return { action, configuration, applied: false, ready_to_apply: true };
    const job = await client.command("firmware/clean", { configuration });
    return { action, configuration, applied: true, job: boundFirmwareJob(job) };
  }
  if (action === "clean_all") {
    if (confirmation !== "RESET ALL ESPHOME BUILDS") {
      throw new Error("confirmation must exactly equal RESET ALL ESPHOME BUILDS");
    }
    if (!apply) return { action, applied: false, ready_to_apply: true, cancels_active_jobs: true };
    const job = await client.command("firmware/reset_build_env", {});
    return { action, applied: true, job: boundFirmwareJob(job) };
  }
  if (action === "rename_online") {
    await requireConfiguredDevice(client, configuration);
    const source = await readFile(client, configuration);
    newName = validateHostname(newName);
    const preview = { action, configuration, new_name: newName, current_sha256: source.sha256 };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    requireExpectedHash(expectedSha256, source.sha256, configuration);
    const result = await client.command("devices/rename", { configuration, new_name: newName, config_only: false });
    return { ...preview, applied: true, result };
  }
  throw new Error(`Unsupported firmware action: ${action}`);
}

export async function streamESPHomeLogs(client, {
  configuration,
  port = "OTA",
  noStates = false,
  durationSeconds = 10,
  maxLines = 200,
}) {
  await requireConfiguredDevice(client, configuration);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 45) {
    throw new Error("duration_seconds must be between 1 and 45");
  }
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 500) {
    throw new Error("max_lines must be between 1 and 500");
  }
  const result = await client.stream("devices/logs", {
    configuration,
    port,
    no_states: Boolean(noStates),
  }, {
    timeoutMs: durationSeconds * 1000,
    maxEvents: maxLines,
    maxChars: MAX_JOB_OUTPUT_CHARS,
    stopCommand: "devices/stop_stream",
  });
  return { configuration, port, ...streamOutput(result) };
}

export async function manageESPHomeSerial(client, {
  action,
  port,
  configuration,
  expectedPlatform,
  apply = false,
}) {
  if (action === "list_ports") return { ports: await client.command("config/serial_ports") };
  if (typeof port !== "string" || !port) throw new Error("port is required");
  const detected = await client.command("config/detect_chip", { port });
  if (action === "detect") return { port, detected };
  if (action === "install") {
    await requireConfiguredDevice(client, configuration);
    if (expectedPlatform && detected?.platform !== expectedPlatform) {
      throw new Error(`Detected platform ${detected?.platform || "unknown"} does not match expected_platform ${expectedPlatform}`);
    }
    const preview = { action, port, configuration, detected, force_local: true };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const head = await client.command("firmware/install", {
      configuration,
      port,
      force_local: true,
      bootloader: false,
    });
    const jobs = await client.command("firmware/get_jobs", { configuration });
    const chain = (Array.isArray(jobs) ? jobs : []).filter((job) => job.job_id === head?.job_id || job.depends_on === head?.job_id);
    return { ...preview, applied: true, head_job: boundFirmwareJob(head), jobs: chain.map(boundFirmwareJob) };
  }
  throw new Error(`Unsupported serial action: ${action}`);
}

export async function manageESPHomePairing(client, {
  action,
  enabled,
  cleanupTtlSeconds,
  hostname,
  port,
  pinSha256,
  receiverLabel = "",
  offloaderLabel = "",
  pairingKey,
  dashboardId,
  confirmation,
  apply = false,
}) {
  if (action === "status") {
    const [receiver, offloader, identity] = await Promise.all([
      client.command("remote_build/get_settings"),
      client.command("remote_build/get_offloader_settings"),
      client.command("remote_build/get_identity"),
    ]);
    return { receiver, offloader, identity };
  }
  if (action === "configure_receiver") {
    if (typeof enabled !== "boolean") throw new Error("enabled is required for configure_receiver");
    const preview = { action, enabled, cleanup_ttl_seconds: cleanupTtlSeconds };
    if (!apply) return { ...preview, applied: false, ready_to_apply: true };
    const args = { enabled };
    if (cleanupTtlSeconds !== undefined) args.cleanup_ttl_seconds = cleanupTtlSeconds;
    return { ...preview, applied: true, result: await client.command("remote_build/set_settings", args) };
  }
  if (action === "preview") {
    return client.command("remote_build/preview_pair", { hostname, port });
  }
  if (action === "request") {
    const observed = await client.command("remote_build/preview_pair", { hostname, port });
    if (observed?.pin_sha256 !== pinSha256) throw new Error("pin_sha256 does not match the receiver observed during preview");
    const preview = { action, hostname, port, pin_sha256: pinSha256, receiver_label: receiverLabel, offloader_label: offloaderLabel };
    const pairingKeyReady = !observed.requires_pairing_key || Boolean(pairingKey);
    if (!apply) return { ...preview, applied: false, ready_to_apply: pairingKeyReady, requires_pairing_key: observed.requires_pairing_key };
    if (!pairingKeyReady) throw new Error("pairing_key is required by this receiver");
    if (confirmation !== `PAIR ${pinSha256}`) throw new Error(`confirmation must exactly equal PAIR ${pinSha256}`);
    const args = {
      hostname,
      port,
      pin_sha256: pinSha256,
      receiver_label: receiverLabel,
      offloader_label: offloaderLabel,
      pairing_key: pairingKey || null,
      offloader_label_auto: !offloaderLabel,
      receiver_label_auto: !receiverLabel,
    };
    return { ...preview, applied: true, result: await client.command("remote_build/request_pair", args) };
  }
  if (action === "approve_peer" || action === "remove_peer") {
    if (typeof dashboardId !== "string" || !dashboardId) throw new Error("dashboard_id is required");
    const verb = action === "approve_peer" ? "APPROVE" : "REMOVE";
    if (!apply) return { action, dashboard_id: dashboardId, applied: false, ready_to_apply: true };
    if (confirmation !== `${verb} ${dashboardId}`) throw new Error(`confirmation must exactly equal ${verb} ${dashboardId}`);
    const command = action === "approve_peer" ? "remote_build/approve_peer" : "remote_build/remove_peer";
    return { action, dashboard_id: dashboardId, applied: true, result: await client.command(command, { dashboard_id: dashboardId }) };
  }
  if (action === "unpair") {
    if (!/^[a-f0-9]{64}$/.test(pinSha256 || "")) throw new Error("pin_sha256 is required for unpair");
    if (!apply) return { action, pin_sha256: pinSha256, applied: false, ready_to_apply: true };
    if (confirmation !== `UNPAIR ${pinSha256}`) throw new Error(`confirmation must exactly equal UNPAIR ${pinSha256}`);
    return { action, pin_sha256: pinSha256, applied: true, result: await client.command("remote_build/unpair", { pin_sha256: pinSha256 }) };
  }
  throw new Error(`Unsupported pairing action: ${action}`);
}
