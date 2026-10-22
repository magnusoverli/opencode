/**
 * Config Validation Helpers
 *
 * Pure functions for YAML structure validation and
 * safe path resolution within the HA config directory.
 */

import { isAbsolute, join, normalize } from "node:path/posix";
import { isAlias, isCollection, isPair, LineCounter, parseDocument, visit } from "yaml";

/** Default HA config directory (can be overridden for testing) */
const DEFAULT_CONFIG_DIR = "/homeassistant";

const MAX_YAML_BYTES = 1024 * 1024;
const MAX_NODES = 50000;
const MAX_DEPTH = 64;
const MAX_ISSUES = 100;
const DEFERRED = Symbol("Home Assistant reference");
// Never resolve a file, secret, environment variable or blueprint input here.
// Only HA's authoritative configuration check may resolve these references.
const HA_TAGS = [
  "!secret", "!env_var", "!input", "!include", "!include_dir_list",
  "!include_dir_named", "!include_dir_merge_list", "!include_dir_merge_named",
].map(tag => ({ tag, resolve: () => DEFERRED }));

function parseStructure(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_YAML_BYTES) {
    return { error: "YAML preflight requires text no larger than 1 MiB." };
  }
  const lineCounter = new LineCounter();
  try {
    const document = parseDocument(content, {
      version: "1.1", merge: true, customTags: HA_TAGS, stringKeys: true,
      uniqueKeys: true, lineCounter, prettyErrors: false, logLevel: "error",
    });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) {
      const { line, col } = lineCounter.linePos(problem.pos[0]);
      // Parser messages can echo configuration values. Report only location/code.
      return { error: `Invalid or unsupported YAML (${problem.code}) at line ${line}, column ${col}.` };
    }
    let nodes = 0, exceeded = false;
    const anchors = new Map(), references = new WeakMap();
    visit(document, (_key, node, ancestors) => {
      if (++nodes > MAX_NODES || ancestors.length > MAX_DEPTH) {
        exceeded = true;
        return visit.BREAK;
      }
      if (node?.anchor) anchors.set(node.anchor, node);
      if (isAlias(node)) references.set(node, anchors.get(node.source));
    });
    if (exceeded) return { error: "YAML preflight exceeds the 64-level or 50,000-node limit." };
    // Bound expansion BEFORE toJS: merge aliases may copy mappings rather than
    // taking the library's ordinary alias-conversion path. Memoized costs avoid
    // materializing either merge bombs or exponentially nested alias graphs.
    const active = new WeakSet(), costs = new WeakMap();
    const cost = (node, depth = 0) => {
      if (depth > MAX_DEPTH) throw new Error();
      if (!node || typeof node !== "object") return { size: 1, height: 0 };
      if (active.has(node)) throw new Error();
      if (costs.has(node)) return costs.get(node);
      active.add(node);
      let children = [];
      if (isAlias(node)) {
        if (!references.get(node)) throw new Error();
        children = [references.get(node)];
      } else if (isPair(node)) children = [node.key, node.value];
      else if (isCollection(node)) children = node.items;
      let size = 1, height = 0;
      for (const child of children) {
        const next = cost(child, depth + 1);
        size += next.size;
        height = Math.max(height, next.height + 1);
        if (size > MAX_NODES || height > MAX_DEPTH) throw new Error();
      }
      active.delete(node);
      const result = { size, height };
      costs.set(node, result);
      return result;
    };
    cost(document.contents);
    return { value: document.toJS({ mapAsMap: true, maxAliasCount: 100 }) };
  } catch {
    return { error: "YAML references are invalid, cyclic or exceed preflight expansion limits." };
  }
}

/**
 * Validate YAML content for structural issues in automations, scripts,
 * and template sensors. This is bounded, local preflight, not an HA schema
 * replacement. filePath identifies standard standalone automation/script files;
 * arbitrary include-file layouts must be checked by HA, not guessed here.
 */
export function validateYamlStructure(yamlContent, filePath = "") {
  const parsed = parseStructure(yamlContent);
  if (parsed.error) return [{ severity: "error", message: parsed.error }];
  const issues = [];
  let checks = 0;
  const add = (location, message, severity = "error") => {
    if (issues.length >= MAX_ISSUES - 1) throw new Error();
    issues.push({ severity, message: `${location}: ${message}` });
  };
  const childPath = (location, key) => `${location}[${JSON.stringify(String(key).slice(0, 100))}]`;
  const mapping = (value, location) => {
    if (++checks > MAX_NODES) throw new Error();
    if (value === DEFERRED) return false;
    if (value instanceof Map) return true;
    add(location, "Expected a YAML mapping.");
    return false;
  };
  const each = (value, location, inspect) => {
    if (value === DEFERRED || value == null) return;
    if (Array.isArray(value)) value.forEach((entry, index) => inspect(entry, `${location}[${index}]`));
    else inspect(value, location); // HA also accepts a single mapping.
  };
  const blueprint = (value, location) => {
    if (!value.has("use_blueprint")) return false;
    const reference = value.get("use_blueprint");
    if (mapping(reference, `${location}.use_blueprint`)) {
      const path = reference.get("path");
      if (path !== DEFERRED && (typeof path !== "string" || !path.trim())) add(location, "Blueprint reference requires a path.");
    }
    return true; // Triggers/actions/sequence come from the blueprint, not this file.
  };
  const steps = (value, location) => each(value, location, mapping);
  const automation = (value, location) => {
    if (!mapping(value, location) || blueprint(value, location)) return;
    for (const [singular, plural] of [["trigger", "triggers"], ["action", "actions"]]) {
      if (!value.has(singular) && !value.has(plural)) add(location, `Automation is missing '${singular}:' (or '${plural}:').`);
      for (const key of [singular, plural]) if (value.has(key)) steps(value.get(key), `${location}.${key}`);
    }
  };
  const script = (value, location) => {
    if (!mapping(value, location) || blueprint(value, location)) return;
    if (!value.has("sequence")) add(location, "Script may be missing a 'sequence:' key.", "warning");
    else steps(value.get("sequence"), `${location}.sequence`);
  };
  const scripts = (value, location) => {
    if (value == null || !mapping(value, location)) return;
    for (const [name, entry] of value) script(entry, childPath(location, name));
  };
  const template = (value, location) => {
    if (!mapping(value, location)) return;
    for (const kind of ["sensor", "binary_sensor"]) if (value.has(kind)) {
      each(value.get(kind), `${location}.${kind}`, (entity, entityPath) => {
        if (mapping(entity, entityPath) && !entity.has("state") && !entity.has("value_template")) {
          add(entityPath, "Template sensor definition may be missing a 'state:' key.", "warning");
        }
      });
    }
  };
  const visited = new WeakSet();
  const config = (value, location = "config") => {
    if (!mapping(value, location) || visited.has(value)) return;
    visited.add(value);
    for (const [key, entry] of value) {
      const at = childPath(location, key);
      if (key === "automation" || /^automation\s+\S/.test(key)) each(entry, at, automation);
      else if (key === "script" || /^script\s+\S/.test(key)) scripts(entry, at);
      else if (key === "template" || /^template\s+\S/.test(key)) each(entry, at, template);
    }
    const home = value.get("homeassistant");
    if (home instanceof Map && home.has("packages")) {
      const packages = home.get("packages");
      if (packages != null && mapping(packages, `${location}.homeassistant.packages`)) {
        for (const [name, entry] of packages) config(entry, childPath(`${location}.homeassistant.packages`, name));
      }
    }
  };
  try {
    const root = parsed.value;
    if (root == null || root === DEFERRED) return issues;
    const filename = normalize(filePath).replace(/^\/homeassistant\//, "");
    if (filename === "automations.yaml") each(root, "automation", automation);
    else if (filename === "scripts.yaml") scripts(root, "script");
    else if (root instanceof Map) {
      const domain = root.get("blueprint")?.get?.("domain");
      if (domain === "automation") automation(root, "blueprint");
      else if (domain === "script") script(root, "blueprint");
      else config(root);
    }
    // Other standalone include layouts are ambiguous (e.g. a list of scenes
    // versus automations). Syntax was checked; domain validation belongs to HA.
  } catch {
    return [{ severity: "error", message: "YAML structure exceeds preflight traversal or diagnostic limits." }];
  }
  return issues;
}

/**
 * Safely resolve and validate a file path within the HA config directory.
 * Returns the resolved absolute path, or null if the path is invalid/unsafe.
 *
 * @param {string} filePath - The path to resolve
 * @param {string} [configDir] - The config directory (defaults to /homeassistant)
 */
export function resolveConfigPath(filePath, configDir = DEFAULT_CONFIG_DIR) {
  // Reject absolute paths that point outside config dir
  if (isAbsolute(filePath) && !filePath.startsWith(configDir)) {
    return null;
  }

  // Resolve relative paths against the config directory
  const resolved = isAbsolute(filePath) ? filePath : join(configDir, filePath);
  const normalized = normalize(resolved);

  // Ensure the resolved path is still within the config directory
  if (!normalized.startsWith(configDir)) {
    return null;
  }

  // Block access to internal directories
  const relativePath = normalized.substring(configDir.length + 1);
  const blocked = [".storage", ".cloud", "deps", "tts", "__pycache__"];
  if (blocked.some(dir => relativePath.startsWith(dir + "/") || relativePath === dir)) {
    return null;
  }

  return normalized;
}
