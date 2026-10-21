import { describe, it, expect } from "vitest";
import { validateYamlStructure, resolveConfigPath } from "../lib/validation.js";
import { packageYaml } from "./fixtures/safe-write-package.js";

// ---------------------------------------------------------------------------
// validateYamlStructure
// ---------------------------------------------------------------------------

describe("validateYamlStructure", () => {
  it.each([packageYaml, packageYaml.replace(/\n/g, "\r\n"), packageYaml.trimEnd()])(
    "accepts realistic nested automations, trigger-based sensors and multiline scripts without a sentinel", yaml => {
      expect(validateYamlStructure(yaml)).toEqual([]);
    },
  );

  it.each(["trigger", "triggers"])("accepts legacy and modern %s/action keys and labeled sections", key => {
    const yaml = `"automation evening-lights":\n  alias: "Single automation"\n  ${key}:\n    platform: state\n    entity_id: binary_sensor.synthetic\n  action:\n    service: light.turn_on\n"script evening":\n  synthetic:\n    alias: "Script"\n    sequence:\n      - delay: "00:00:01"\n`;
    expect(validateYamlStructure(yaml)).toEqual([]);
  });

  it.each(["trigger", "action"])("detects a missing %s at end-of-file", missing => {
    const body = missing === "trigger" ? "    actions:\n      - delay: 1" : "    triggers:\n      - trigger: event\n        event_type: synthetic";
    const issues = validateYamlStructure(`automation:\n  - alias: "Broken"\n${body}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain(`missing '${missing}:'`);
    expect(issues[0].message).toContain("[0]");
  });

  it("checks each script and template entity independently, preserving warning severity", () => {
    const yaml = `script:\n  valid:\n    alias: "Valid"\n    sequence:\n      - delay: 1\n  missing:\n    alias: "Missing"\ntemplate:\n  - sensor:\n      - name: "Valid"\n        state: "1"\n      - name: "Missing"\n`;
    const issues = validateYamlStructure(yaml);
    expect(issues).toHaveLength(2);
    expect(issues.every(issue => issue.severity === "warning")).toBe(true);
    expect(issues[0].message).toContain('script"]["missing"]');
    expect(issues[1].message).toContain("sensor[1]");
  });

  it("expands anchored mappings and merge lists with correct override precedence", () => {
    const yaml = `automation:\n  - &base\n    alias: "Base"\n    triggers:\n      - trigger: event\n        event_type: synthetic\n    actions:\n      - delay: 1\n  - <<: [*base]\n    alias: "Merged"\n`;
    expect(validateYamlStructure(yaml)).toEqual([]);
    expect(validateYamlStructure(yaml + "    actions: false\n")).toMatchObject([{ severity: "error" }]);
  });

  it.each(["!secret", "!env_var", "!input", "!include", "!include_dir_list", "!include_dir_named", "!include_dir_merge_list", "!include_dir_merge_named"])(
    "treats %s as an opaque HA reference, never its argument as a definition", tag => {
      expect(validateYamlStructure(`automation: ${tag} /does-not-exist/synthetic.yaml\nscript: ${tag} synthetic\ntemplate: ${tag} synthetic\n`)).toEqual([]);
    },
  );

  it("accepts deferred action/trigger inputs and blueprint instances without resolving their files", () => {
    const yaml = `automation:\n  - alias: "Blueprint instance"\n    use_blueprint:\n      path: synthetic/missing.yaml\n  - triggers: !input synthetic_triggers\n    actions: !include synthetic_actions.yaml\nscript:\n  synthetic:\n    use_blueprint:\n      path: synthetic/missing-script.yaml\n`;
    expect(validateYamlStructure(yaml)).toEqual([]);
    expect(validateYamlStructure('automation:\n  - use_blueprint: {}\n')).toMatchObject([{ severity: "error" }]);
    expect(validateYamlStructure('blueprint:\n  domain: automation\ntriggers: !input synthetic\nactions: !input synthetic\n')).toEqual([]);
  });

  it("validates inline packages but does not mistake unrelated nested data for integrations", () => {
    const indent = text => text.split("\n").map(line => `      ${line}`).join("\n");
    expect(validateYamlStructure(`homeassistant:\n  packages:\n    synthetic:\n${indent(packageYaml)}`)).toEqual([]);
    expect(validateYamlStructure('homeassistant:\n  packages:\n    synthetic:\n      automation:\n        - alias: "Missing keys"\n')).toMatchObject([{ severity: "error" }, { severity: "error" }]);
    expect(validateYamlStructure('homeassistant:\n  packages:\n    synthetic: false\n')).toMatchObject([{ severity: "error" }]);
    expect(validateYamlStructure('other_integration:\n  payload:\n    automation:\n      - alias: "Not an HA automation"\n')).toEqual([]);
  });

  it("uses file context for standard standalone files, not arbitrary include basenames", () => {
    expect(validateYamlStructure('- alias: "Missing keys"\n', "/homeassistant/automations.yaml")).toHaveLength(2);
    expect(validateYamlStructure('synthetic:\n  alias: "Missing sequence"\n', "scripts.yaml")).toMatchObject([{ severity: "warning" }]);
    expect(validateYamlStructure(packageYaml, "/homeassistant/packages/automations.yaml")).toEqual([]);
    expect(validateYamlStructure('- name: "Scene, not automation"\n', "includes/automations.yaml")).toEqual([]);
  });

  it.each([
    "automation: false", "automation:\n  - false", "script:\n  synthetic: false",
    "template:\n  - sensor: false", "automation:\n  - triggers: false\n    actions: []",
    "automation: [unclosed", "a: 1\na: 2", "a: !unsupported value",
    "a: *missing", "a: &self\n  child: *self", "a:\n  <<: false", "---\na: 1\n---\nb: 2",
  ])("rejects malformed YAML, shapes and references: %s", yaml => {
    const issues = validateYamlStructure(yaml);
    expect(issues.some(issue => issue.severity === "error")).toBe(true);
  });

  it("rejects parser/alias/depth/size/diagnostic exhaustion without exposing source values", () => {
    const privateValue = "synthetic-sensitive-value-must-not-appear";
    const bad = `a: "${privateValue}\n`;
    expect(JSON.stringify(validateYamlStructure(bad))).not.toContain(privateValue);
    for (const yaml of [
      "x".repeat(1024 * 1024 + 1), "[".repeat(100) + "0" + "]".repeat(100),
      "items:\n" + "  - x\n".repeat(50001),
      "a: &a [1, 2, 3, 4, 5]\nb: &b [*a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c]\n",
      "base: &base\n" + Array.from({ length: 500 }, (_, i) => `  key_${i}: value\n`).join("") + "copies:\n" + "  - <<: *base\n".repeat(200),
      "script:\n" + Array.from({ length: 101 }, (_, i) => `  script_${i}:\n    alias: "Missing sequence"\n`).join(""),
    ]) expect(validateYamlStructure(yaml)).toMatchObject([{ severity: "error" }]);
  });

  it.each(["", "# Only a comment\n", "automation:\nscript:\ntemplate:\n", "automation:\n  - triggers: []\n    actions: []\n"])("accepts empty configurations and explicitly empty lists", yaml => {
    expect(validateYamlStructure(yaml)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

describe("resolveConfigPath", () => {
  // Use a test config dir to avoid platform-specific path separator issues
  const configDir = "/homeassistant";

  it("resolves a simple relative path", () => {
    const result = resolveConfigPath("automations.yaml", configDir);
    expect(result).toBe("/homeassistant/automations.yaml");
  });

  it("resolves a nested relative path", () => {
    const result = resolveConfigPath("packages/lights.yaml", configDir);
    expect(result).toBe("/homeassistant/packages/lights.yaml");
  });

  it("allows an absolute path inside the config dir", () => {
    const result = resolveConfigPath("/homeassistant/secrets.yaml", configDir);
    expect(result).toBe("/homeassistant/secrets.yaml");
  });

  it("rejects an absolute path outside the config dir", () => {
    const result = resolveConfigPath("/etc/passwd", configDir);
    expect(result).toBeNull();
  });

  it("rejects traversal attacks (..)", () => {
    const result = resolveConfigPath("../etc/passwd", configDir);
    expect(result).toBeNull();
  });

  it("blocks .storage access", () => {
    const result = resolveConfigPath(".storage/core.entity_registry", configDir);
    expect(result).toBeNull();
  });

  it("blocks .cloud access", () => {
    const result = resolveConfigPath(".cloud/remote.json", configDir);
    expect(result).toBeNull();
  });

  it("blocks deps access", () => {
    const result = resolveConfigPath("deps/some_package", configDir);
    expect(result).toBeNull();
  });

  it("blocks tts access", () => {
    const result = resolveConfigPath("tts/cache.mp3", configDir);
    expect(result).toBeNull();
  });

  it("blocks __pycache__ access", () => {
    const result = resolveConfigPath("__pycache__/module.pyc", configDir);
    expect(result).toBeNull();
  });

  it("allows custom_components (not in blocklist)", () => {
    const result = resolveConfigPath("custom_components/hacs/manifest.json", configDir);
    expect(result).toBe("/homeassistant/custom_components/hacs/manifest.json");
  });
});
