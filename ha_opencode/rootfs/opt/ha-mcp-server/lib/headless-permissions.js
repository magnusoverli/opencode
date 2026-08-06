import path from "path";
import YAML from "yaml";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeRecords(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = isRecord(result[key]) && isRecord(value) ? mergeRecords(result[key], value) : value;
  }
  return result;
}

function normalizedEditPermission(edit, worktree) {
  if (typeof edit === "string") return edit === "ask" ? "deny" : edit;
  if (!isRecord(edit)) return undefined;

  const normalized = {
    "*": edit["*"] === "ask" ? "deny" : (edit["*"] ?? "deny"),
  };
  const root = path.posix.normalize(worktree);

  for (const [pattern, action] of Object.entries(edit)) {
    if (pattern === "*") continue;
    normalized[pattern] = action;
  }

  // OpenCode evaluates edit rules relative to the worktree but documents
  // absolute paths for external-directory rules. Retain both forms here.
  for (const [pattern, action] of Object.entries(edit)) {
    if (!pattern.startsWith(`${root}/`)) continue;
    const relative = path.posix.relative(root, pattern);
    if (relative && !relative.startsWith("../")) normalized[relative] = action;
  }

  return normalized;
}

function mergeAgentEdit(agents, name, agent) {
  const edit = agent?.permission?.edit;
  if (edit === undefined) return;

  const existing = agents.get(name);
  if (isRecord(existing) && isRecord(edit)) {
    agents.set(name, mergeRecords(existing, edit));
    return;
  }
  agents.set(name, edit);
}

export function parseAgentFrontmatter(content) {
  const match = content.match(/^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const parsed = YAML.parse(match[1]);
  return isRecord(parsed) ? parsed : undefined;
}

export function buildHeadlessPermissionConfig({
  config = {},
  environmentConfig = {},
  markdownAgents = [],
  worktree = "/homeassistant",
} = {}) {
  const agents = new Map();
  for (const [name, agent] of Object.entries(config.agent ?? {})) mergeAgentEdit(agents, name, agent);
  for (const { name, agent } of markdownAgents) mergeAgentEdit(agents, name, agent);
  for (const [name, agent] of Object.entries(environmentConfig.agent ?? {})) mergeAgentEdit(agents, name, agent);

  const globalPermission = mergeRecords(config.permission ?? {}, environmentConfig.permission ?? {});
  const overlay = {
    permission: {
      edit: normalizedEditPermission(globalPermission.edit, worktree) ?? "deny",
    },
  };

  for (const [name, edit] of agents) {
    const normalized = normalizedEditPermission(edit, worktree);
    if (normalized === undefined) continue;
    overlay.agent ??= {};
    overlay.agent[name] = { permission: { edit: normalized } };
  }

  return mergeRecords(environmentConfig, overlay);
}
