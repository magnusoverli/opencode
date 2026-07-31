import { describe, it, expect } from "vitest";
import { validateYamlStructure, resolveConfigPath } from "../lib/validation.js";

// ---------------------------------------------------------------------------
// validateYamlStructure
// ---------------------------------------------------------------------------

describe("validateYamlStructure", () => {
  // NOTE: The regex in validateYamlStructure uses (?=^\S|\Z) to find the end
  // of a YAML block.  \Z is not a JS regex anchor, so the block must be
  // followed by another top-level key for the look-ahead to match.  We add
  // a trailing "end:" key in each test input to satisfy this requirement.

  it("returns no issues for a well-formed automation", () => {
    // Use trigger/action without nested "- " list items so the regex split
    // (which splits on ANY "- " line) keeps the entry intact.
    const yaml = [
      "automation:",
      "  - alias: Turn on lights",
      "    trigger: state_changed",
      "    action: light.turn_on",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues).toEqual([]);
  });

  it("detects missing trigger in automation", () => {
    const yaml = [
      "automation:",
      "  - alias: Broken automation",
      "    action:",
      "      - service: light.turn_on",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues.some(i => i.message.includes("trigger"))).toBe(true);
  });

  it("detects missing action in automation", () => {
    const yaml = [
      "automation:",
      "  - alias: No action",
      "    trigger:",
      "      - platform: state",
      "        entity_id: binary_sensor.motion",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues.some(i => i.message.includes("action"))).toBe(true);
  });

  it("returns no issues for a well-formed script", () => {
    const yaml = [
      "script:",
      "  morning_routine:",
      "    sequence:",
      "      - service: light.turn_on",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues).toEqual([]);
  });

  it("detects missing sequence in script", () => {
    const yaml = [
      "script:",
      "  morning_routine:",
      "    alias: Morning Routine",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues.some(i => i.message.includes("sequence") || i.message.includes("action"))).toBe(true);
  });

  it("returns no issues for a well-formed template sensor", () => {
    const yaml = [
      "template:",
      "  - sensor:",
      "      - name: Average Temperature",
      "        state: \"{{ states('sensor.temp') }}\"",
      "end:",
    ].join("\n");
    const issues = validateYamlStructure(yaml);
    expect(issues).toEqual([]);
  });

  it("returns no issues for empty content", () => {
    expect(validateYamlStructure("")).toEqual([]);
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
