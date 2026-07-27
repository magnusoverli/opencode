/**
 * Deterministic facts about a Home Assistant installation.
 *
 * These are the things an agent otherwise rediscovers from scratch in every
 * session — how the configuration is split up, which areas exist, what is
 * actually installed. Collecting them here means it happens once per add-on
 * start, in the add-on's own privileged context, instead of costing tool calls
 * in each conversation.
 *
 * Filesystem access is injected so the scanners can be tested without a real
 * Home Assistant configuration directory.
 */

export const DEFAULT_CONFIG_DIR = "/homeassistant";

/** Pathological-file guard: no configuration file needs more than this. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const TOP_LEVEL_FILES = [
  "configuration.yaml",
  "automations.yaml",
  "scripts.yaml",
  "scenes.yaml",
  "secrets.yaml",
  "customize.yaml",
  "ui-lovelace.yaml",
  "known_devices.yaml",
];

const NOTABLE_DIRECTORIES = [
  "packages",
  "custom_components",
  "esphome",
  "blueprints",
  "themes",
  "python_scripts",
  "www",
];

const INCLUDE_DIRECTIVES = [
  "include_dir_merge_named",
  "include_dir_merge_list",
  "include_dir_named",
  "include_dir_list",
  "include",
];

/** Integrations that determine how a home is wired, not just what it contains. */
const RADIO_INTEGRATIONS = new Set([
  "zha",
  "zwave_js",
  "matter",
  "deconz",
  "esphome",
  "tasmota",
  "insteon",
  "homekit_controller",
]);

function wrapFs(fsApi) {
  return {
    async readFile(path) {
      try {
        return await fsApi.readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async readdir(path) {
      try {
        return await fsApi.readdir(path, { withFileTypes: true });
      } catch {
        return null;
      }
    },
    async stat(path) {
      try {
        return await fsApi.stat(path);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Parse the top level of `configuration.yaml`.
 *
 * Deliberately line-scanned rather than YAML-parsed: Home Assistant's `!include`
 * family and `!secret` are custom tags that make a strict parser throw, and a
 * scanner that always produces something is worth more than one that is exact
 * but fails on the first unusual file.
 */
export function parseConfigurationYaml(text) {
  const keys = [];
  const includes = [];
  let inlinePackages = false;
  let currentTopKey = null;

  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const topLevel = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (topLevel) {
      currentTopKey = topLevel[1];
      keys.push(currentTopKey);
      const remainder = topLevel[2];
      const directive = matchIncludeDirective(remainder);
      if (directive) includes.push({ key: currentTopKey, ...directive });
      continue;
    }

    // `homeassistant:` -> `  packages: !include_dir_named packages`
    const nested = /^\s+([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (nested) {
      const [, nestedKey, remainder] = nested;
      const directive = matchIncludeDirective(remainder);
      if (directive) {
        includes.push({ key: `${currentTopKey ?? ""}.${nestedKey}`.replace(/^\./, ""), ...directive });
      }
      if (nestedKey === "packages") inlinePackages = true;
    }
  }

  return { keys: [...new Set(keys)], includes, inlinePackages };
}

function matchIncludeDirective(remainder) {
  const value = String(remainder ?? "").trim();
  if (!value.startsWith("!")) return null;
  for (const directive of INCLUDE_DIRECTIVES) {
    if (value.startsWith(`!${directive}`)) {
      const target = value.slice(directive.length + 1).trim().split(" #")[0].trim();
      return { directive, target: target || null };
    }
  }
  return null;
}

/**
 * Count top-level list entries (`automations.yaml`, `scenes.yaml`).
 *
 * A `- ` at column zero is a top-level sequence item and nothing else, which
 * makes this reliable without parsing megabytes of YAML.
 */
export function countListEntries(text) {
  let count = 0;
  let withId = 0;
  for (const rawLine of String(text ?? "").split("\n")) {
    if (!/^- /.test(rawLine)) continue;
    count += 1;
    if (/^- id:\s*/.test(rawLine)) withId += 1;
  }
  return { count, withId };
}

/** Count top-level mapping keys (`scripts.yaml`). */
export function countMappingKeys(text) {
  let count = 0;
  for (const rawLine of String(text ?? "").split("\n")) {
    if (/^[A-Za-z0-9_-]+:/.test(rawLine)) count += 1;
  }
  return count;
}

/**
 * Scan the configuration directory.
 *
 * Works with Home Assistant Core stopped — this is the part of the briefing
 * that is always available, which matters because the add-on starts alongside
 * Core rather than after it.
 */
export async function scanConfigLayout(fsApi, configDir = DEFAULT_CONFIG_DIR) {
  const fs = wrapFs(fsApi);
  const join = (name) => `${configDir}/${name}`;

  const files = {};
  await Promise.all(
    TOP_LEVEL_FILES.map(async (name) => {
      const stat = await fs.stat(join(name));
      if (stat?.isFile?.()) files[name] = { bytes: stat.size };
    }),
  );

  const layout = {
    files,
    topLevelKeys: [],
    includes: [],
    packages: null,
    automations: null,
    scripts: null,
    scenes: null,
    directories: {},
    customComponents: [],
    versionControlled: false,
  };

  if (files["configuration.yaml"] && files["configuration.yaml"].bytes <= MAX_SCAN_BYTES) {
    const text = await fs.readFile(join("configuration.yaml"));
    if (text !== null) {
      const parsed = parseConfigurationYaml(text);
      layout.topLevelKeys = parsed.keys;
      layout.includes = parsed.includes;
      if (parsed.inlinePackages) {
        // The directory is whatever the include points at — telling the model to
        // put new configuration in `packages/` when the user calls it something
        // else sends it to write in a directory Home Assistant does not read.
        const include = parsed.includes.find((entry) => entry.key === "homeassistant.packages");
        layout.packages = { configured: true, directory: include?.target || "packages" };
      }
    }
  }

  if (files["automations.yaml"] && files["automations.yaml"].bytes <= MAX_SCAN_BYTES) {
    const text = await fs.readFile(join("automations.yaml"));
    if (text !== null) {
      const { count, withId } = countListEntries(text);
      layout.automations = {
        count,
        // The Automations editor stamps every entry it owns with a numeric id
        // and rewrites the whole file on save. Knowing this up front is the
        // difference between editing the file and fighting the UI over it.
        uiManaged: count > 0 && withId >= Math.ceil(count / 2),
      };
    }
  }

  if (files["scripts.yaml"] && files["scripts.yaml"].bytes <= MAX_SCAN_BYTES) {
    const text = await fs.readFile(join("scripts.yaml"));
    if (text !== null) layout.scripts = { count: countMappingKeys(text) };
  }

  if (files["scenes.yaml"] && files["scenes.yaml"].bytes <= MAX_SCAN_BYTES) {
    const text = await fs.readFile(join("scenes.yaml"));
    if (text !== null) layout.scenes = { count: countListEntries(text).count };
  }

  await Promise.all(
    NOTABLE_DIRECTORIES.map(async (name) => {
      const entries = await fs.readdir(join(name));
      if (!entries) return;
      if (name === "custom_components") {
        layout.customComponents = entries
          .filter((entry) => entry.isDirectory?.() && !entry.name.startsWith("__") && !entry.name.startsWith("."))
          .map((entry) => entry.name)
          .sort();
        layout.directories[name] = layout.customComponents.length;
        return;
      }
      layout.directories[name] = entries.filter((entry) => !entry.name.startsWith(".")).length;
    }),
  );

  if (typeof layout.directories.packages === "number") {
    layout.packages = { ...(layout.packages ?? {}), fileCount: layout.directories.packages, configured: true };
  }

  const gitDir = await fs.stat(join(".git"));
  layout.versionControlled = Boolean(gitDir?.isDirectory?.());

  return layout;
}

/** Areas with their floor, ordered for stable output. */
export function summarizeAreas(areas = [], floors = []) {
  const floorsById = new Map((floors ?? []).map((floor) => [floor.floor_id, floor.name]));
  return (areas ?? [])
    .map((area) => ({
      name: area.name || area.area_id,
      floor: area.floor_id ? floorsById.get(area.floor_id) ?? null : null,
    }))
    .filter((area) => area.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Entity count per domain, highest first. */
export function countEntityDomains(states = []) {
  const counts = new Map();
  for (const state of states ?? []) {
    const entityId = typeof state === "string" ? state : state?.entity_id;
    const domain = String(entityId ?? "").split(".")[0];
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain, count]) => ({ domain, count }));
}

/**
 * Integrations actually in use, derived from the entity registry.
 *
 * The registry's `platform` field is the integration that provides each entity,
 * which is both more accurate than the loaded-component list and readable
 * without the admin-only config-entries API.
 */
export function extractIntegrations(entityRegistry = []) {
  const platforms = new Set();
  for (const entry of entityRegistry ?? []) {
    if (entry?.platform) platforms.add(entry.platform);
  }
  return [...platforms].sort();
}

/** Radio and device-protocol stacks in play, which shape most advice. */
export function detectStacks(integrations = [], options = {}) {
  const radios = (integrations ?? []).filter((integration) => RADIO_INTEGRATIONS.has(integration));
  if (options.z2mConfigured) radios.push("zigbee2mqtt");
  return [...new Set(radios)].sort();
}

/**
 * Compose the offline scan and whatever Home Assistant returned into the shape
 * the briefing renderer expects.
 *
 * Live data is optional throughout: the add-on starts alongside Home Assistant
 * rather than after it, so a briefing built from the filesystem alone is a
 * normal outcome and still worth writing.
 *
 * @param {object} input
 * @param {string} input.generatedAt ISO timestamp
 * @param {object|null} input.layout result of `scanConfigLayout`
 * @param {object|null} input.live result of `collectLiveFacts`
 * @param {object|null} input.addon add-on capability flags
 * @param {boolean} [input.z2mConfigured]
 */
/** What a briefing is missing when Home Assistant could not be reached at all. */
const FULLY_DEGRADED = Object.freeze([
  "Home Assistant version and settings",
  "areas",
  "entity inventory",
  "integrations",
]);

export function buildBriefingFacts(input) {
  const { generatedAt, layout = null, live = null, addon = null, z2mConfigured = false } = input ?? {};

  const integrations = live?.entityRegistry ? extractIntegrations(live.entityRegistry) : null;
  const stacks = integrations || z2mConfigured ? detectStacks(integrations ?? [], { z2mConfigured }) : null;

  return {
    generatedAt,
    core: summarizeCore(live?.config ?? null, live?.supervisorInfo ?? null),
    layout,
    areas: live?.areas ? summarizeAreas(live.areas, live.floors ?? []) : null,
    entityCounts: live?.states ? countEntityDomains(live.states) : null,
    integrations,
    stacks: stacks?.length ? stacks : null,
    addon,
    // No live data at all is the *most* degraded case, not the absence of a
    // problem. Reporting `[]` here made a configuration-only briefing claim, by
    // omission, to be a complete picture of the installation.
    degraded: live ? live.degraded ?? [] : FULLY_DEGRADED,
  };
}

/** Normalize `/api/config` into the few fields worth spending context on. */
export function summarizeCore(config, supervisorInfo) {
  if (!config && !supervisorInfo) return null;
  const unitSystem = config?.unit_system ?? {};
  return {
    version: config?.version ?? null,
    timeZone: config?.time_zone ?? null,
    // Temperature and length are what actually change generated YAML.
    units: unitSystem.temperature || unitSystem.length
      ? { temperature: unitSystem.temperature ?? null, length: unitSystem.length ?? null }
      : null,
    language: config?.language ?? null,
    state: config?.state ?? null,
    operatingSystem: supervisorInfo?.operating_system ?? null,
    machine: supervisorInfo?.machine ?? null,
  };
}
