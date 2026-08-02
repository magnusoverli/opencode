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
      mcpToolProfile: "full",
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
    expect(result.bytes).toBeLessThanOrEqual(HOME_BRIEFING_BUDGET_BYTES);
  });

  /**
   * The fixture above is a small installation, so it fits trivially and proves
   * little. A perfectly ordinary mid-size home used to lose Areas, Integrations
   * and Add-on capabilities outright — with a third of the budget unspent and no
   * mention that anything was missing.
   */
  describe("a mid-size installation", () => {
    const midSize = () =>
      facts({
        areas: Array.from({ length: 18 }, (_, i) => ({
          name: `Area ${i + 1}`,
          floor: i < 9 ? "Ground floor" : "First floor",
        })),
        integrations: Array.from({ length: 34 }, (_, i) => `integration_${i}`),
        stacks: ["zha", "esphome", "matter"],
        entityCounts: [
          { domain: "sensor", count: 412 },
          { domain: "binary_sensor", count: 188 },
          { domain: "light", count: 64 },
          { domain: "switch", count: 52 },
          { domain: "automation", count: 87 },
          { domain: "button", count: 44 },
        ],
        layout: {
          ...facts().layout,
          topLevelKeys: Array.from({ length: 20 }, (_, i) => `key_${i}`),
          customComponents: ["hacs", "alarmo", "browser_mod", "frigate", "powercalc", "scheduler", "spook"],
          automations: { count: 87, uiManaged: true },
        },
      });

    it("keeps every section", () => {
      const result = renderHomeBriefing(midSize());
      expect(result.droppedSections).toEqual([]);
      for (const id of ["core", "layout", "areas", "entities", "integrations", "addon"]) {
        expect(result.includedSections).toContain(id);
      }
    });

    it("still names the areas rather than dropping the list", () => {
      const markdown = renderHomeBriefing(midSize()).markdown;
      expect(markdown).toContain("## Areas (18)");
      expect(markdown).toContain("Area 1 (Ground floor)");
      expect(markdown).toContain("do not invent or guess them");
    });

    it("tells the model what it can do, so it does not offer what it cannot", () => {
      expect(renderHomeBriefing(midSize()).markdown).toContain("## Add-on capabilities");
    });
  });

  // A section that vanishes silently reads as "this installation has none of
  // those", and the model acts on that.
  it("names what it left out when the budget forces a section out", () => {
    const result = renderHomeBriefing(facts(), { budgetBytes: 900 });
    expect(result.droppedSections.length).toBeGreaterThan(0);
    expect(result.markdown).toContain("Omitted for space");
    expect(result.markdown).toContain("Absent here does not mean absent from the installation");
    for (const id of result.droppedSections) {
      const label = { entities: "entity counts", addon: "add-on capabilities", integrations: "integrations", areas: "areas", core: "Home Assistant version and settings", layout: "configuration layout" }[id];
      expect(result.markdown).toContain(label);
    }
    expect(result.bytes).toBeLessThanOrEqual(900);
  });

  // "Omitted for space" for a home that simply has no areas inverts the very
  // distinction the notice exists to make.
  it("does not report an absent section as omitted for space", () => {
    const bare = facts({ areas: null, integrations: null, stacks: null });
    const result = renderHomeBriefing(bare);
    expect(result.droppedSections).not.toContain("areas");
    expect(result.droppedSections).not.toContain("integrations");
    expect(result.markdown).not.toContain("Omitted for space");
  });

  it("says when layout bullets were trimmed rather than dropping them quietly", () => {
    const result = renderHomeBriefing(facts(), { budgetBytes: 900 });
    const layout = result.markdown.includes("## Configuration layout");
    if (layout) {
      const trimmed = /further layout detail/.test(result.markdown);
      const complete = result.markdown.includes("top-level keys");
      expect(trimmed || complete).toBe(true);
    }
  });

  it("counts every integration the list leaves out", () => {
    const many = facts({ integrations: Array.from({ length: 90 }, (_, i) => `integration_${i}`) });
    const markdown = renderHomeBriefing(many).markdown;
    const match = markdown.match(/\+(\d+) more/);
    expect(match).toBeTruthy();
    const shown = (markdown.match(/integration_\d+/g) ?? []).length;
    expect(shown + Number(match[1])).toBe(90);
  });

  it("shrinks a long list instead of dropping the whole section", () => {
    const many = facts({ areas: Array.from({ length: 60 }, (_, i) => ({ name: `Area ${i}`, floor: null })) });
    const result = renderHomeBriefing(many);
    expect(result.includedSections).toContain("areas");
    expect(result.markdown).toContain("## Areas (60)");
    expect(result.markdown).toMatch(/\+\d+ more/);
    expect(result.bytes).toBeLessThanOrEqual(HOME_BRIEFING_BUDGET_BYTES);
  });

  it.each([256, 512, 900, 1400, 2048, 4096])("never exceeds a %i-byte budget", (budgetBytes) => {
    const big = facts({
      areas: Array.from({ length: 200 }, (_, i) => ({ name: `Area ${i}`, floor: `Floor ${i % 4}` })),
      integrations: Array.from({ length: 150 }, (_, i) => `integration_${i}`),
    });
    expect(renderHomeBriefing(big, { budgetBytes }).bytes).toBeLessThanOrEqual(budgetBytes);
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

  it("identifies a scoped MCP tool profile", () => {
    const result = renderHomeBriefing(facts({ addon: { ...facts().addon, mcpToolProfile: "compact" } }));
    expect(result.markdown).toContain("MCP tools (compact profile)");
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
