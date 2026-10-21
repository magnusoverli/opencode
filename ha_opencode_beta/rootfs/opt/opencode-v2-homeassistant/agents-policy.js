import { ConfigAgent } from "@opencode/schema/config/agent";
import { Permission } from "@opencode/schema/permission";
import { Schema } from "effect";
import { createHash } from "node:crypto";

export const AGENT_DIRECTORIES = ["agents", "agent", "modes", "mode"];
export const MAX_AGENT_BYTES = 64 * 1024;
export const MAX_AGENTS = 64;
export const AGENT_REVISION_ACTION = "ha.managed-agent-revision";
export const PROTECTED_AGENTS = new Set(["home-assistant-read-only", "home-assistant-assist", "title", "summary", "compaction"]);
const decode = Schema.decodeUnknownSync(ConfigAgent.Info, { onExcessProperty: "error" });
const decodePermissions = Schema.decodeUnknownSync(Permission.Ruleset, { onExcessProperty: "error" });
const fields = new Set(["description", "system", "model", "mode", "hidden", "disabled", "color", "steps", "request", "permissions"]);

export class AgentSettingsError extends Error {
  constructor(message, status = 400) { super(message); this.name = "AgentSettingsError"; this.status = status; }
}

export function validateAgentId(id) {
  if (typeof id !== "string" || id.length > 160 || id.split("/").length > 4 ||
      id.split("/").some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) {
    throw new AgentSettingsError("Invalid agent name");
  }
  if (PROTECTED_AGENTS.has(id) || id.startsWith("home-assistant-")) {
    throw new AgentSettingsError("This agent is managed by the add-on and cannot be overridden", 403);
  }
  return id;
}

function inert(value, depth = 0) {
  if (depth > 16) throw new AgentSettingsError("Agent configuration is too deeply nested");
  if (typeof value === "string" && (/\{(?:file|env):/i.test(value) || value.includes("\0"))) {
    throw new AgentSettingsError("Agent file/environment substitutions and NUL characters are not supported");
  }
  if (Array.isArray(value)) value.forEach(item => inert(item, depth + 1));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || /\{(?:file|env):/i.test(key)) {
        throw new AgentSettingsError("Unsafe agent configuration key");
      }
      inert(item, depth + 1);
    }
  }
}

export function validateAgentConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) {
    throw new AgentSettingsError("Use native V2 agent fields only; runtime, plugin and integration configuration is not supported");
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_AGENT_BYTES || (input.permissions?.length ?? 0) > 128) {
    throw new AgentSettingsError("Agent configuration exceeds its size or permission limit");
  }
  inert(input);
  try { decode(input); } catch { throw new AgentSettingsError("Invalid native V2 agent configuration"); }
  return structuredClone(input);
}

export function updateAgentConfig(previous, updates) {
  if (Object.keys(updates).some(key => !fields.has(key))) throw new AgentSettingsError("Use native V2 agent fields only");
  validateAgentConfig(Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== null)));
  const result = structuredClone(previous);
  for (const [key, value] of Object.entries(updates)) { if (value === null) delete result[key]; else result[key] = value; }
  return validateAgentConfig(result);
}

// Decide overlap of the native '*'/'?' wildcard languages without guessing shell
// syntax. The input/rule limits bound this product automaton; no regex executes
// user-supplied syntax and an allow exception can never relax a managed ask.
function overlaps(left, right) {
  if (process.platform === "win32") { left = left.toLowerCase(); right = right.toLowerCase(); }
  const pending = [[0, 0]], seen = new Set();
  while (pending.length) {
    const [i, j] = pending.pop(), key = `${i}:${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 65536) return true; // Conservatively cap pathological patterns.
    if (i === left.length && j === right.length) return true;
    if (left[i] === "*") pending.push([i + 1, j]);
    if (right[j] === "*") pending.push([i, j + 1]);
    if (i < left.length && j < right.length && (left[i] === "*" || right[j] === "*" || left[i] === "?" || right[j] === "?" || left[i] === right[j])) {
      pending.push([i + (left[i] === "*" ? 0 : 1), j + (right[j] === "*" ? 0 : 1)]);
    }
  }
  return false;
}

export function agentPolicy(permissions) {
  try { decodePermissions(permissions); } catch { throw new AgentSettingsError("Managed agent permission policy is unavailable", 503); }
  return permissions.filter(rule => rule.effect !== "allow").map(rule => ({ ...rule }));
}

export function constrainAgent(config, guards) {
  const requests = (config.permissions ?? []).filter(rule => rule.action !== AGENT_REVISION_ACTION && !guards.some(guard => guard.effect === "deny" &&
    rule.action === guard.action && rule.resource === guard.resource && rule.effect === guard.effect));
  const permissions = requests.map(rule => ({ ...rule, effect: rule.effect === "allow" && guards.some(guard =>
    guard.effect === "ask" && overlaps(rule.action, guard.action) && overlaps(rule.resource, guard.resource)) ? "ask" : rule.effect }));
  // Keep user deny/ask ordering. Only mandatory denials are appended; appending
  // global allows or asks here would accidentally weaken a user's stricter deny.
  permissions.push(...guards.filter(rule => rule.effect === "deny").map(rule => ({ ...rule })));
  const result = { ...structuredClone(config), permissions };
  // The pinned native agent API has no config revision/readiness token. A deny
  // on this unused action fingerprints the compiled definition, including field
  // removals. Its disappearance verifies builtin restoration after deletion.
  const revision = createHash("sha256").update(JSON.stringify(canonicalAgentConfig(result))).digest("hex");
  permissions.push({ action: AGENT_REVISION_ACTION, resource: revision, effect: "deny" });
  return result;
}

export function agentInfoFields(config) {
  const { disabled: _disabled, model, ...values } = structuredClone(config);
  if (model !== undefined) {
    const parsed = decode(config).model;
    values.model = { providerID: parsed.providerID, id: parsed.model, ...(parsed.variant ? { variant: parsed.variant } : {}) };
  }
  return values;
}

export const canonicalAgentConfig = config => JSON.parse(JSON.stringify(decode(config)));
