import { describe, it, expect } from "vitest";
import { byteLength } from "../lib/context-budget.js";
import { HOME_BRIEFING_BUDGET_BYTES, renderHomeBriefing } from "../lib/home-briefing.js";

function facts(overrides = {}) {
  return {
    generatedAt: "2026-07-26T09:00:00Z",
    core: {
      version: "2026.7.2",
      timeZone: "Europe/Oslo",
      units: { temperature: "°C", length: "km" },
      language: "en",
      operatingSystem: "Home Assistant OS 14.2",
      machine: "green",
    },
    layout: {
      files: { "configuration.yaml": { bytes: 400 } },
      topLevelKeys: ["default_config", "automation"],
      includes: [{ key: "automation", directive: "include", target: "automations.yaml" }],
      packages: { configured: true, fileCount: 12 },
      automations: { count: 34, uiManaged: true },
      scripts: { count: 8 },
      scenes: { count: 3 },
      directories: { esphome: 14, www: 22 },
      customComponents: ["hacs", "alarmo"],
      versionControlled: true,
    },
    areas: [
      { name: "Kitchen", floor: "Ground floor" },
      { name: "Living Room", floor: "Ground floor" },
      { name: "Attic", floor: null },
    ],
    entityCounts: [
      { domain: "sensor", count: 142 },
      { domain: "light", count: 34 },
    ],
    integrations: ["esphome", "hue", "mqtt", "zha"],
    stacks: ["esphome", "zha"],
    addon: {
      mcp: true,
      lsp: true,
      screenshot: false,
      addonAccess: false,
      restrictSensitiveFiles: true,
    },
    degraded: [],
    ...overrides,
  };
}

describe("renderHomeBriefing", () => {
  it("includes every section for a complete installation", () => {
    const result = renderHomeBriefing(facts());
    expect(result.includedSections).toEqual([
      "header",
      "core",
      "layout",
      "areas",
      "entities",
      "integrations",
      "addon",
    ]);
    expect(result.droppedSections).toEqual([]);
  });

  it("stays inside the byte budget", () => {
    const result = renderHomeBriefing(facts());
    expect(result.bytes).toBeLessThanOrEqual(HOME_BRIEFING_BUDGET_BYTES + 1); // +1 for the trailing newline
  });

  it("stays inside the budget for a very large installation", () => {
    const big = facts({
      areas: Array.from({ length: 200 }, (_, i) => ({ name: `Area ${i}`, floor: `Floor ${i % 4}` })),
      integrations: Array.from({ length: 150 }, (_, i) => `integration_${i}`),
      entityCounts: Array.from({ length: 60 }, (_, i) => ({ domain: `domain_${i}`, count: 100 - i })),
      layout: {
        ...facts().layout,
        customComponents: Array.from({ length: 80 }, (_, i) => `component_${i}`),
        topLevelKeys: Array.from({ length: 60 }, (_, i) => `key_${i}`),
      },
    });
    const result = renderHomeBriefing(big);
    expect(result.bytes).toBeLessThanOrEqual(HOME_BRIEFING_BUDGET_BYTES + 1);
  });

  it("reports the true total even when the list is capped", () => {
    const many = facts({ areas: Array.from({ length: 90 }, (_, i) => ({ name: `Area ${i}`, floor: null })) });
    const result = renderHomeBriefing(many, { budgetBytes: 8000 });
    expect(result.markdown).toContain("## Areas (90)");
    expect(result.markdown).toContain("more");
  });

  it("keeps the offline-derivable sections when Home Assistant was unreachable", () => {
    const offline = facts({
      core: null,
      areas: null,
      entityCounts: null,
      integrations: null,
      stacks: null,
      degraded: ["areas", "entity inventory", "integrations"],
    });
    const result = renderHomeBriefing(offline);
    expect(result.includedSections).toContain("layout");
    expect(result.markdown).toContain("Home Assistant Core was not reachable");
    expect(result.markdown).toContain("`automations.yaml`: 34 entries");
  });

  it("warns that a UI-managed automations.yaml is rewritten by the editor", () => {
    const result = renderHomeBriefing(facts());
    expect(result.markdown).toContain("UI-managed");
  });

  it("labels hand-written automations differently", () => {
    const handWritten = facts({
      layout: { ...facts().layout, automations: { count: 4, uiManaged: false } },
    });
    const result = renderHomeBriefing(handWritten);
    expect(result.markdown).toContain("hand-written");
  });

  it("tells the model which add-on capabilities are unavailable", () => {
    const result = renderHomeBriefing(facts());
    expect(result.markdown).toContain("Not available:");
    expect(result.markdown).toContain("screenshot tool");
  });

  it("frames itself as a snapshot rather than live state", () => {
    const result = renderHomeBriefing(facts());
    expect(result.markdown).toContain("not as live state");
  });

  it("drops low-priority sections before high-priority ones under pressure", () => {
    const result = renderHomeBriefing(facts(), { budgetBytes: 700 });
    expect(result.includedSections).toContain("header");
    expect(result.droppedSections).toContain("addon");
    expect(byteLength(result.markdown)).toBeLessThanOrEqual(701);
  });

  it("renders something usable from almost no facts", () => {
    const result = renderHomeBriefing({
      generatedAt: "2026-07-26T09:00:00Z",
      layout: null,
      core: null,
      degraded: [],
    });
    expect(result.markdown).toContain("Home Assistant install briefing");
    expect(result.includedSections).toEqual(["header"]);
  });
});
