// Publish only validated agent entries into the existing private OPENCODE_CONFIG.
// The separately retained base is image-generated, never user agent input.
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_REVISION_ACTION, AgentSettingsError, agentPolicy, constrainAgent, validateAgentConfig, validateAgentId } from "./agents-policy.js";
import { createAgentStore } from "./agents-store.js";

export const MANAGED_AGENTS_BASE = "/run/opencode-v2/agents-base.json";
export const MANAGED_CONFIG_FILE = "/run/opencode-v2/managed.json";
const MAX_MANAGED_BYTES = 4 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const unsafe = () => new AgentSettingsError("Private managed agent configuration is unavailable or unsafe", 503);

async function withDocument(filename, action) {
  const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022)))) throw unsafe();
    const root = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : path.dirname(filename);
    return await action(root, path.basename(filename), directory);
  } finally { await directory.close(); }
}

async function readDocument(root, name) {
  const file = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_MANAGED_BYTES ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600))) throw unsafe();
    const buffer = Buffer.alloc(MAX_MANAGED_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANAGED_BYTES) throw unsafe();
    const bytes = buffer.subarray(0, bytesRead);
    try { return { value: JSON.parse(bytes.toString("utf8")), etag: hash(bytes) }; } catch { throw unsafe(); }
  } finally { await file.close(); }
}

export const readManagedDocument = filename => withDocument(filename, readDocument);

async function publish(filename, value, expected) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (bytes.length > MAX_MANAGED_BYTES) throw new AgentSettingsError("Imported agents exceed the managed configuration size limit");
  return withDocument(filename, async (root, name, directory) => {
    let temporary;
    const unchanged = async () => {
      try { return (await readDocument(root, name)).etag === expected; }
      catch (error) { if (error.code === "ENOENT") return expected === null; throw error; }
    };
    if (!await unchanged()) throw new AgentSettingsError("Managed configuration changed concurrently; restart before applying agents", 409);
    try {
      temporary = `.agent-config-${randomUUID()}`;
      const file = await open(path.join(root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (!await unchanged()) throw new AgentSettingsError("Managed configuration changed concurrently; restart before applying agents", 409);
      await rename(path.join(root, temporary), path.join(root, name)); temporary = undefined;
      if (process.platform === "linux") await directory.sync();
      return hash(bytes);
    } finally { if (temporary) await unlink(path.join(root, temporary)).catch(() => {}); }
  });
}

export function createAgentImporter({ base, store = createAgentStore(), managedPath = MANAGED_CONFIG_FILE,
  read = () => readManagedDocument(managedPath), write = (value, expected) => publish(managedPath, value, expected),
} = {}) {
  base = structuredClone(base);
  const guards = agentPolicy(base.permissions);
  let active, expected, pending = Promise.resolve();
  const refresh = async () => {
    const current = await read();
    if (expected !== undefined && current.etag !== expected) throw new AgentSettingsError("Managed configuration changed concurrently; restart before applying agents", 409);
    const { agents: currentAgents, ...currentOther } = current.value;
    const { agents: baseAgents = {}, ...baseOther } = base;
    if (JSON.stringify(currentOther) !== JSON.stringify(baseOther)) throw unsafe();
    if (!active) {
      active = new Map();
      for (const [id, config] of Object.entries(currentAgents ?? {})) {
        if (Object.hasOwn(baseAgents, id)) continue;
        validateAgentId(id);
        const permissions = (config.permissions ?? []).filter(rule => rule.action !== AGENT_REVISION_ACTION && !guards.some(guard =>
          guard.effect === "deny" && guard.action === rule.action && guard.resource === rule.resource && guard.effect === rule.effect));
        active.set(id, { config: validateAgentConfig({ ...config, permissions }) });
      }
    }
    const snapshot = await store.scan();
    for (const { id } of snapshot.errors) if (active.has(id)) snapshot.entries.set(id, active.get(id));
    for (const id of snapshot.entries.keys()) if (Object.hasOwn(baseAgents, id)) {
      snapshot.entries.delete(id);
      snapshot.errors.push({ id, message: "This agent is managed by the add-on and cannot be overridden" });
    }
    const agents = Object.fromEntries([...snapshot.entries].map(([id, entry]) => [id, constrainAgent(entry.config, guards)]));
    // Protected/image-owned definitions always win, including future entries.
    const next = { ...base, agents: { ...agents, ...baseAgents } };
    if (JSON.stringify(current.value) === JSON.stringify(next)) {
      if ((await read()).etag !== current.etag) throw new AgentSettingsError("Managed configuration changed concurrently; restart before applying agents", 409);
      expected = current.etag;
    } else expected = await write(next, current.etag);
    active = snapshot.entries;
    return { applied: [...active.keys()], rejected: snapshot.errors };
  };
  return {
    managedPath,
    refresh() {
      const operation = pending.then(refresh);
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

export async function initializeAgentImporter(managedPath, { basePath = MANAGED_AGENTS_BASE, store = createAgentStore() } = {}) {
  const document = await readManagedDocument(managedPath);
  await publish(basePath, document.value, null);
  const result = await createAgentImporter({ base: document.value, managedPath, store }).refresh();
  if (result.rejected.length) console.warn("Some custom agent files were not imported. Correct their native V2 fields in Settings > Agents.");
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 || path.dirname(process.argv[2]) !== "/run/opencode-v2" || !/^\.managed\.[a-zA-Z0-9]+$/.test(path.basename(process.argv[2]))) throw unsafe();
    await initializeAgentImporter(process.argv[2]);
  } catch { console.error("Custom agents could not be imported safely; the managed configuration was not activated"); process.exitCode = 1; }
}
