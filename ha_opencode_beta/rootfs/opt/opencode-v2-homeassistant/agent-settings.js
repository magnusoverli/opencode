// Process-private UI/backend bridge. Only Markdown agents cross this boundary;
// global opencode.json, plugins, environment and project config stay isolated.
import { OpenCode, isAgentNotFoundError } from "@opencode/client";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_REVISION_ACTION, AgentSettingsError, PROTECTED_AGENTS, agentInfoFields, agentPolicy, canonicalAgentConfig, constrainAgent, updateAgentConfig, validateAgentId } from "./agents-policy.js";
import { createAgentStore, DEFAULT_AGENTS_ROOT, encodeAgentFile } from "./agents-store.js";
import { createAgentImporter } from "./agents-importer.js";

export const AGENT_SETTINGS_KEY = Symbol.for("ha.openchamber.agent-settings");
const builtins = new Set(["build", "plan", "general", "explore"]);
const subset = (actual, expected) => expected && typeof expected === "object"
  ? actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  : actual === expected;

export function createAgentSettingsBridge({ password, base, permissions = base?.permissions, directory = DEFAULT_AGENTS_ROOT,
  workspace = "/run/opencode-v2/workspace", store = createAgentStore(directory),
  importer = createAgentImporter({ base, store }),
  client = OpenCode.make({ baseUrl: "http://127.0.0.1:4100", headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }),
} = {}) {
  const guards = agentPolicy(permissions);
  let pending = Promise.resolve();
  const options = () => ({ signal: AbortSignal.timeout(1000) });
  const healthy = async () => {
    try { await client.server.info(options()); }
    catch { throw new AgentSettingsError("The agent was not applied: the managed backend is unavailable", 503); }
  };
  const native = async (id, location) => {
    try { return (await client.agent.get({ agentID: id, location }, options())).data; }
    catch (error) { if (isAgentNotFoundError(error)) return null; throw new AgentSettingsError("Cannot verify the backend agent", 503); }
  };
  const source = async id => {
    if (PROTECTED_AGENTS.has(id) || Object.hasOwn(base?.agents ?? {}, id)) return undefined;
    const snapshot = await store.scan();
    if (snapshot.errors.some(error => error.id === id)) throw new AgentSettingsError("This agent file is invalid, duplicated or unsafe; correct the persistent file before editing it", 422);
    return snapshot.entries.get(id);
  };
  const metadata = entry => ({ source: entry ? "md" : "none", scope: entry ? "user" : null,
    path: entry ? path.join(store.root, entry.path) : null, legacy: false });
  const normalized = filename => process.platform === "win32" ? path.resolve(filename).toLowerCase() : path.resolve(filename);
  const verified = async (id, config, location) => {
    const documents = await client.config.get({ location }, options());
    const document = documents.find(entry => entry.type === "document" && entry.path && normalized(entry.path) === normalized(importer.managedPath));
    if (!document) return false;
    const expected = config ? constrainAgent(config, guards) : undefined;
    const actual = document.info.agents?.[id];
    if (expected ? !actual || JSON.stringify(canonicalAgentConfig(actual)) !== JSON.stringify(canonicalAgentConfig(expected)) : actual !== undefined) return false;
    const active = await native(id, location);
    if (config && !config.disabled) {
      const { permissions: rules, ...fields } = agentInfoFields(expected);
      if (!subset(active, fields)) return false;
      // Native defaults/global rules precede the imported agent; downstream
      // native safety denials (e.g. the absent browser plugin) may follow it.
      return rules.length === 0 || active.permissions.some((_rule, start) =>
        rules.every((rule, index) => subset(active.permissions[start + index], rule)) &&
        active.permissions.slice(start + rules.length).every(rule => rule.effect === "deny"));
    }
    return config?.disabled || !builtins.has(id) ? !active : Boolean(active) && !active.permissions.some(rule => rule.action === AGENT_REVISION_ACTION);
  };
  const waitForActivation = async (id, config, location) => {
    const deadline = Date.now() + 10000;
    do {
      try { if (await verified(id, config, location)) return; } catch {}
      await sleep(75);
    } while (Date.now() < deadline);
    throw new AgentSettingsError("The backend did not activate the saved agent settings", 503);
  };

  async function read(operation, id, location) {
    if (operation === "disabled") {
      const snapshot = await store.scan();
      return { agents: [...snapshot.entries].filter(([, entry]) => entry.config.disabled).map(([name]) => name), rejected: snapshot.errors };
    }
    const entry = await source(id), info = metadata(entry);
    const config = entry?.config ?? {};
    if (operation === "config") return { ...info, config, managed: true, protected: PROTECTED_AGENTS.has(id) || Object.hasOwn(base?.agents ?? {}, id),
      policyNote: "Global agents only. Add-on denials and confirmation requirements cannot be relaxed." };
    if (operation === "permissions") {
      const active = await native(id, location);
      return { global: permissions, agent: config.permissions ?? [], effective: (active?.permissions ?? []).filter(rule => rule.action !== AGENT_REVISION_ACTION), ...info };
    }
    const md = { exists: Boolean(entry), path: info.path, scope: info.scope, legacy: false, fields: Object.keys(config) };
    return { name: id, scope: info.scope, isBuiltIn: !entry, managed: true, sources: {
      md, json: { exists: false, path: null, scope: null, legacy: false, fields: [] },
      projectMd: { exists: false, path: null }, userMd: { exists: Boolean(entry), path: info.path },
    } };
  }

  async function mutate(operation, id, input, location) {
    validateAgentId(id);
    if (Object.hasOwn(base?.agents ?? {}, id)) throw new AgentSettingsError("This agent is managed by the add-on and cannot be overridden", 403);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentSettingsError("Agent settings must be an object");
    const { scope, ...updates } = input;
    if (scope !== undefined && scope !== "user") throw new AgentSettingsError("Only global user agents are supported; project agents are not loaded by this managed runtime");
    if (operation === "delete" && Object.keys(updates).length) throw new AgentSettingsError("Unexpected delete settings");
    const previous = await source(id);
    if (operation === "create" && previous) throw new AgentSettingsError("Agent already exists", 409);
    if (operation === "delete" && !previous) throw new AgentSettingsError("No imported agent override exists", 404);
    let bytes = null, config;
    if (operation !== "delete") {
      config = updateAgentConfig(operation === "create" ? {} : previous?.config ?? {}, updates);
      bytes = encodeAgentFile(config);
    }
    // Verify availability before writing, then verify the actual registered
    // fields after refresh. Disk persistence is never reported as activation.
    await healthy();
    const relative = previous?.path ?? `agents/${id}.md`;
    const nextEtag = await store.replace(relative, previous?.etag ?? null, bytes);
    try {
      const activated = await importer.refresh();
      if (activated.rejected.some(error => error.id === id) || activated.applied.includes(id) !== (operation !== "delete")) throw new AgentSettingsError("Backend rejected the agent", 503);
      const current = await source(id);
      if ((current?.etag ?? null) !== nextEtag) throw new AgentSettingsError("Agent changed during activation; reload its current settings", 409);
      await waitForActivation(id, current?.config, location);
      if (((await source(id))?.etag ?? null) !== nextEtag) throw new AgentSettingsError("Agent changed during activation; reload its current settings", 409);
      return { success: true, applied: true, message: "Agent settings are active on the managed backend.", ...metadata(current) };
    } catch (error) {
      let restored = false, reactivated = false;
      try { await store.replace(relative, nextEtag, previous?.bytes ?? null); restored = true; await importer.refresh(); await waitForActivation(id, previous?.config, location); reactivated = true; } catch {}
      throw new AgentSettingsError(restored
        ? `Agent activation failed; the previous saved settings were restored.${reactivated ? " The backend rollback was verified." : " Backend rollback could not be verified; restart the add-on before continuing."}`
        : "Agent activation failed and a newer edit or storage failure prevented rollback. Reload and inspect the current saved settings.", error.status === 409 ? 409 : 503);
    }
  }

  return {
    async handle(operation, id, input = {}, selectedDirectory) {
      if (operation !== "disabled") {
        if (PROTECTED_AGENTS.has(id) && ["metadata", "config", "permissions"].includes(operation)) { /* readable, never writable */ }
        else validateAgentId(id);
      }
      const activeDirectory = selectedDirectory ?? workspace;
      if (typeof activeDirectory !== "string" || !path.isAbsolute(activeDirectory)) throw new AgentSettingsError("Invalid workspace directory");
      const location = { directory: activeDirectory };
      if (["metadata", "config", "permissions", "disabled"].includes(operation)) return read(operation, id, location);
      if (!["create", "update", "delete"].includes(operation)) throw new AgentSettingsError("Unsupported agent operation");
      const operationPromise = pending.then(() => mutate(operation, id, input, location));
      pending = operationPromise.catch(() => {});
      return operationPromise;
    },
  };
}
