import { describe, it, expect } from "vitest";
import {
  buildBriefingFacts,
  countEntityDomains,
  countListEntries,
  countMappingKeys,
  detectStacks,
  extractIntegrations,
  parseConfigurationYaml,
  scanConfigLayout,
  summarizeAreas,
  summarizeCore,
} from "../lib/home-facts.js";

/**
 * Minimal in-memory stand-in for `fs/promises`, so layout scanning can be
 * exercised without a real Home Assistant configuration directory.
 *
 * @param {Record<string, string>} files  path -> contents
 * @param {Record<string, string[]>} dirs path -> entry names ("name/" = directory)
 */
function fakeFs(files = {}, dirs = {}) {
  return {
    async readFile(path) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path];
    },
    async readdir(path) {
      if (!(path in dirs)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return dirs[path].map((name) => ({
        name: name.replace(/\/$/, ""),
        isDirectory: () => name.endsWith("/"),
        isFile: () => !name.endsWith("/"),
      }));
    },
    async stat(path) {
      if (path in files) {
        return { size: Buffer.byteLength(files[path]), isFile: () => true, isDirectory: () => false };
      }
      if (path in dirs) {
        return { size: 0, isFile: () => false, isDirectory: () => true };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

// ---------------------------------------------------------------------------
// parseConfigurationYaml
// ---------------------------------------------------------------------------

describe("parseConfigurationYaml", () => {
  it("collects top-level keys and include directives", () => {
    const yaml = [
      "# Loads default set of integrations.",
      "default_config:",
      "",
      "automation: !include automations.yaml",
      "script: !include scripts.yaml",
      "scene: !include scenes.yaml",
      "sensor: !include_dir_merge_list sensors/",
    ].join("\n");

    const result = parseConfigurationYaml(yaml);
    expect(result.keys).toEqual(["default_config", "automation", "script", "scene", "sensor"]);
    expect(result.includes).toEqual([
      { key: "automation", directive: "include", target: "automations.yaml" },
      { key: "script", directive: "include", target: "scripts.yaml" },
      { key: "scene", directive: "include", target: "scenes.yaml" },
      { key: "sensor", directive: "include_dir_merge_list", target: "sensors/" },
    ]);
  });

  it("detects packages configured under homeassistant:", () => {
    const yaml = ["homeassistant:", "  name: Home", "  packages: !include_dir_named packages"].join("\n");
    const result = parseConfigurationYaml(yaml);
    expect(result.inlinePackages).toBe(true);
    expect(result.includes).toEqual([
      { key: "homeassistant.packages", directive: "include_dir_named", target: "packages" },
    ]);
  });

  it("prefers the longest matching include directive", () => {
    // `!include_dir_merge_named` must not be read as `!include`
    const result = parseConfigurationYaml("sensor: !include_dir_merge_named sensors");
    expect(result.includes[0].directive).toBe("include_dir_merge_named");
  });

  it("ignores comments and !secret values", () => {
    const yaml = ["# automation: !include nope.yaml", "http:", "  api_password: !secret http_password"].join("\n");
    const result = parseConfigurationYaml(yaml);
    expect(result.keys).toEqual(["http"]);
    expect(result.includes).toEqual([]);
  });

  it("does not throw on empty or malformed input", () => {
    expect(parseConfigurationYaml("").keys).toEqual([]);
    expect(parseConfigurationYaml(null).keys).toEqual([]);
    expect(parseConfigurationYaml("\t\t: :: broken").keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// entry counting
// ---------------------------------------------------------------------------

describe("countListEntries", () => {
  it("counts top-level sequence items only", () => {
    const yaml = [
      "- id: '1699999999999'",
      "  alias: One",
      "  actions:",
      "    - action: light.turn_on",
      "- id: '1700000000000'",
      "  alias: Two",
    ].join("\n");
    const result = countListEntries(yaml);
    expect(result.count).toBe(2);
    expect(result.withId).toBe(2);
  });

  it("distinguishes hand-written entries without ids", () => {
    const yaml = ["- alias: Hand written", "  trigger: []", "- alias: Also hand written"].join("\n");
    const result = countListEntries(yaml);
    expect(result.count).toBe(2);
    expect(result.withId).toBe(0);
  });

  it("returns zero for an empty file", () => {
    expect(countListEntries("").count).toBe(0);
  });
});

describe("countMappingKeys", () => {
  it("counts top-level script ids", () => {
    const yaml = ["good_morning:", "  sequence: []", "  alias: Morning", "good_night:", "  sequence: []"].join("\n");
    expect(countMappingKeys(yaml)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// scanConfigLayout
// ---------------------------------------------------------------------------

describe("scanConfigLayout", () => {
  it("builds a layout from a typical split configuration", async () => {
    const fs = fakeFs(
      {
        "/ha/configuration.yaml": [
          "default_config:",
          "automation: !include automations.yaml",
          "homeassistant:",
          "  packages: !include_dir_named packages",
        ].join("\n"),
        "/ha/automations.yaml": ["- id: '1'", "  alias: A", "- id: '2'", "  alias: B"].join("\n"),
        "/ha/scripts.yaml": ["morning:", "  sequence: []"].join("\n"),
        "/ha/scenes.yaml": "- name: Movie\n",
      },
      {
        "/ha/packages": ["lights.yaml", "climate.yaml"],
        "/ha/custom_components": ["hacs/", "alarmo/", "__pycache__/"],
        "/ha/esphome": ["kitchen.yaml"],
        "/ha/.git": ["HEAD"],
      },
    );

    const layout = await scanConfigLayout(fs, "/ha");

    expect(Object.keys(layout.files).sort()).toEqual([
      "automations.yaml",
      "configuration.yaml",
      "scenes.yaml",
      "scripts.yaml",
    ]);
    expect(layout.topLevelKeys).toContain("default_config");
    expect(layout.packages).toEqual({ configured: true, fileCount: 2, directory: "packages" });
    expect(layout.automations).toEqual({ count: 2, uiManaged: true });
    expect(layout.scripts).toEqual({ count: 1 });
    expect(layout.scenes).toEqual({ count: 1 });
    expect(layout.customComponents).toEqual(["alarmo", "hacs"]);
    expect(layout.directories.esphome).toBe(1);
    expect(layout.versionControlled).toBe(true);
  });

  it("survives a configuration directory that is missing everything", async () => {
    const layout = await scanConfigLayout(fakeFs(), "/nowhere");
    expect(layout.files).toEqual({});
    expect(layout.topLevelKeys).toEqual([]);
    expect(layout.automations).toBeNull();
    expect(layout.versionControlled).toBe(false);
  });

  it("marks hand-written automations as not UI-managed", async () => {
    const fs = fakeFs({ "/ha/automations.yaml": "- alias: One\n- alias: Two\n" });
    const layout = await scanConfigLayout(fs, "/ha");
    expect(layout.automations).toEqual({ count: 2, uiManaged: false });
  });

  it("excludes dotfiles from directory counts", async () => {
    const fs = fakeFs({}, { "/ha/www": ["community/", ".gitkeep", "logo.png"] });
    const layout = await scanConfigLayout(fs, "/ha");
    expect(layout.directories.www).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// registry summaries
// ---------------------------------------------------------------------------

describe("summarizeAreas", () => {
  it("attaches floor names and sorts alphabetically", () => {
    const areas = [
      { area_id: "kitchen", name: "Kitchen", floor_id: "ground" },
      { area_id: "attic", name: "Attic", floor_id: "top" },
      { area_id: "hall", name: "Hall", floor_id: null },
    ];
    const floors = [
      { floor_id: "ground", name: "Ground floor" },
      { floor_id: "top", name: "Top floor" },
    ];
    expect(summarizeAreas(areas, floors)).toEqual([
      { name: "Attic", floor: "Top floor" },
      { name: "Hall", floor: null },
      { name: "Kitchen", floor: "Ground floor" },
    ]);
  });

  it("falls back to the area id when a name is missing", () => {
    expect(summarizeAreas([{ area_id: "shed" }], [])).toEqual([{ name: "shed", floor: null }]);
  });

  it("tolerates a missing floor registry on older Home Assistant", () => {
    expect(summarizeAreas([{ area_id: "a", name: "A", floor_id: "x" }])).toEqual([{ name: "A", floor: null }]);
  });
});

describe("countEntityDomains", () => {
  it("counts per domain, highest first", () => {
    const states = [
      { entity_id: "light.a" },
      { entity_id: "light.b" },
      { entity_id: "sensor.a" },
      { entity_id: "sensor.b" },
      { entity_id: "sensor.c" },
      { entity_id: "switch.a" },
    ];
    expect(countEntityDomains(states)).toEqual([
      { domain: "sensor", count: 3 },
      { domain: "light", count: 2 },
      { domain: "switch", count: 1 },
    ]);
  });

  it("ignores malformed entries", () => {
    expect(countEntityDomains([{}, { entity_id: "" }, null])).toEqual([]);
  });
});

describe("extractIntegrations", () => {
  it("returns distinct sorted platforms", () => {
    const registry = [
      { entity_id: "light.a", platform: "hue" },
      { entity_id: "light.b", platform: "hue" },
      { entity_id: "sensor.a", platform: "esphome" },
    ];
    expect(extractIntegrations(registry)).toEqual(["esphome", "hue"]);
  });
});

describe("detectStacks", () => {
  it("picks out radio integrations", () => {
    expect(detectStacks(["hue", "zha", "esphome", "sun"])).toEqual(["esphome", "zha"]);
  });

  it("adds Zigbee2MQTT when the add-on has it configured", () => {
    expect(detectStacks(["mqtt"], { z2mConfigured: true })).toEqual(["zigbee2mqtt"]);
  });
});

describe("summarizeCore", () => {
  it("keeps only the fields worth spending context on", () => {
    const summary = summarizeCore(
      {
        version: "2026.7.2",
        time_zone: "Europe/Oslo",
        unit_system: { temperature: "°C", length: "km" },
        language: "en",
        state: "RUNNING",
        latitude: 59.9,
        longitude: 10.7,
      },
      { operating_system: "Home Assistant OS 14.2", machine: "green" },
    );

    expect(summary).toEqual({
      version: "2026.7.2",
      timeZone: "Europe/Oslo",
      units: { temperature: "°C", length: "km" },
      language: "en",
      state: "RUNNING",
      operatingSystem: "Home Assistant OS 14.2",
      machine: "green",
    });
  });

  it("never carries location coordinates", () => {
    const summary = summarizeCore({ version: "2026.7.2", latitude: 59.9, longitude: 10.7 }, null);
    expect(JSON.stringify(summary)).not.toContain("59.9");
    expect(JSON.stringify(summary)).not.toContain("10.7");
  });

  it("returns null when nothing was reachable", () => {
    expect(summarizeCore(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBriefingFacts
// ---------------------------------------------------------------------------

describe("buildBriefingFacts", () => {
  // Reporting no gaps when nothing at all was collected made a briefing built
  // from files alone look like a complete picture of the installation.
  it("reports everything as missing when Home Assistant was not reachable", () => {
    const facts = buildBriefingFacts({ generatedAt: "2026-07-27T09:00:00Z", layout: {}, live: null });
    expect(facts.degraded.length).toBeGreaterThan(0);
    expect(facts.degraded).toContain("areas");
    expect(facts.degraded).toContain("entity inventory");
  });

  it("reports no gaps when everything came back", () => {
    const facts = buildBriefingFacts({
      generatedAt: "2026-07-27T09:00:00Z",
      layout: {},
      live: { config: { version: "2026.7.2" }, areas: [], states: [], entityRegistry: [], degraded: [] },
    });
    expect(facts.degraded).toEqual([]);
  });

  it("passes through the partial gaps Home Assistant reported", () => {
    const facts = buildBriefingFacts({
      generatedAt: "2026-07-27T09:00:00Z",
      layout: {},
      live: { config: { version: "2026.7.2" }, degraded: ["areas"] },
    });
    expect(facts.degraded).toEqual(["areas"]);
  });
});

describe("packages directory", () => {
  const fsFor = (files) => ({
    readFile: async (path) => {
      const name = path.split("/").pop();
      if (files[name] === undefined) throw new Error("no such file");
      return files[name];
    },
    readdir: async () => { throw new Error("no such dir"); },
    stat: async (path) => {
      const name = path.split("/").pop();
      if (files[name] === undefined) throw new Error("no such file");
      return { isFile: () => true, isDirectory: () => false, size: files[name].length };
    },
  });

  // Telling the model to write into `packages/` when the include points somewhere
  // else sends it to a directory Home Assistant never reads.
  it("reports the directory the include actually points at", async () => {
    const layout = await scanConfigLayout(
      fsFor({ "configuration.yaml": "homeassistant:\n  packages: !include_dir_named my_packages\n" }),
      "/config",
    );
    expect(layout.packages).toMatchObject({ configured: true, directory: "my_packages" });
  });

  it("falls back to packages when the target cannot be read", async () => {
    const layout = await scanConfigLayout(
      fsFor({ "configuration.yaml": "homeassistant:\n  packages: !include_dir_named packages\n" }),
      "/config",
    );
    expect(layout.packages.directory).toBe("packages");
  });
});
