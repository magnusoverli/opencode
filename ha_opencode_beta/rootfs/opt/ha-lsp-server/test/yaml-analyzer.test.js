import { describe, it, expect } from "vitest";
import { YamlContextAnalyzer } from "../lib/yaml-analyzer.js";

/**
 * Minimal mock of an LSP TextDocument — enough for the analyzer to work.
 * getText(range?) returns the full text or a substring;
 * offsetAt(pos) and positionAt(offset) do simple line/column math.
 */
function createDoc(text) {
  const lines = text.split("\n");

  // Build a cumulative line-offset table
  const lineOffsets = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1); // +1 for "\n"
  }

  return {
    getText(range) {
      if (!range) return text;
      const start = this.offsetAt(range.start);
      const end = this.offsetAt(range.end);
      return text.substring(start, end);
    },
    offsetAt(pos) {
      return lineOffsets[pos.line] + pos.character;
    },
    positionAt(offset) {
      for (let i = 0; i < lineOffsets.length - 1; i++) {
        if (offset < lineOffsets[i + 1]) {
          return { line: i, character: offset - lineOffsets[i] };
        }
      }
      const lastLine = lineOffsets.length - 1;
      return { line: lastLine, character: offset - lineOffsets[lastLine] };
    },
  };
}

const analyzer = new YamlContextAnalyzer();

// ---------------------------------------------------------------------------
// analyzeContext
// ---------------------------------------------------------------------------

describe("YamlContextAnalyzer.analyzeContext", () => {
  it("identifies key position on an empty line at root level", () => {
    const doc = createDoc("automation:\n  ");
    // cursor at end of line 1 (after two spaces)
    const ctx = analyzer.analyzeContext(doc, { line: 1, character: 2 });
    expect(ctx.inKey).toBe(true);
    expect(ctx.inValue).toBe(false);
  });

  it("identifies value position after colon", () => {
    const doc = createDoc("alias: My Automation");
    const ctx = analyzer.analyzeContext(doc, { line: 0, character: 10 });
    expect(ctx.inValue).toBe(true);
    expect(ctx.key).toBe("alias");
  });

  it("detects Jinja context inside {{ }}", () => {
    const doc = createDoc('value_template: "{{ states(');
    const ctx = analyzer.analyzeContext(doc, { line: 0, character: 27 });
    expect(ctx.inJinja).toBe(true);
  });

  it("does not flag Jinja when braces are closed", () => {
    const doc = createDoc('value_template: "{{ x }}" ');
    const ctx = analyzer.analyzeContext(doc, { line: 0, character: 26 });
    expect(ctx.inJinja).toBe(false);
  });

  it("detects list context", () => {
    const doc = createDoc("trigger:\n  - platform: state");
    const ctx = analyzer.analyzeContext(doc, { line: 1, character: 14 });
    expect(ctx.inList).toBe(true);
  });

  it("finds parent keys via indentation (bug-fix test: currentIndent = prevIndent)", () => {
    const yaml = [
      "automation:",          // 0
      "  trigger:",           // 1
      "    - platform: state",// 2
      "      entity_id: ",    // 3
    ].join("\n");
    const doc = createDoc(yaml);
    const ctx = analyzer.analyzeContext(doc, { line: 3, character: 18 });

    // parentKeys should include both "automation" and "trigger"
    expect(ctx.parentKeys).toContain("automation");
    expect(ctx.parentKeys).toContain("trigger");
    expect(ctx.parentKey).toBe("trigger"); // immediate parent
  });

  it("sets parentKey to the immediate parent only", () => {
    const yaml = [
      "script:",
      "  morning:",
      "    sequence:",
      "      - service: ",
    ].join("\n");
    const doc = createDoc(yaml);
    const ctx = analyzer.analyzeContext(doc, { line: 3, character: 17 });
    expect(ctx.parentKey).toBe("sequence");
  });

  it("detects triggerType when inside trigger block", () => {
    const yaml = [
      "trigger:",
      "  - platform: state",
      "    entity_id: ",
    ].join("\n");
    const doc = createDoc(yaml);
    const ctx = analyzer.analyzeContext(doc, { line: 2, character: 15 });
    expect(ctx.triggerType).toBe("state");
  });

  it("detects domain when inside action block", () => {
    const yaml = [
      "action:",
      "  - service: light.turn_on",
      "    data: ",
    ].join("\n");
    const doc = createDoc(yaml);
    const ctx = analyzer.analyzeContext(doc, { line: 2, character: 10 });
    expect(ctx.domain).toBe("light");
  });

  it("handles root-level cursor gracefully", () => {
    const doc = createDoc("");
    const ctx = analyzer.analyzeContext(doc, { line: 0, character: 0 });
    expect(ctx.parentKeys).toEqual([]);
    expect(ctx.parentKey).toBeNull();
    expect(ctx.inKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findEntityReferences
// ---------------------------------------------------------------------------

describe("YamlContextAnalyzer.findEntityReferences", () => {
  it("finds entity_id: value references", () => {
    const doc = createDoc("entity_id: light.living_room");
    const refs = analyzer.findEntityReferences(doc);
    expect(refs.length).toBe(1);
    expect(refs[0].entityId).toBe("light.living_room");
  });

  it("finds states() Jinja references", () => {
    const doc = createDoc("{{ states('sensor.temp') }}");
    const refs = analyzer.findEntityReferences(doc);
    expect(refs.some(r => r.entityId === "sensor.temp" && r.inJinja)).toBe(true);
  });

  it("finds is_state() Jinja references", () => {
    const doc = createDoc("{{ is_state('binary_sensor.door', 'on') }}");
    const refs = analyzer.findEntityReferences(doc);
    expect(refs.some(r => r.entityId === "binary_sensor.door" && r.inJinja)).toBe(true);
  });

  it("returns empty for text without entity references", () => {
    const doc = createDoc("alias: My Automation");
    expect(analyzer.findEntityReferences(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findServiceReferences
// ---------------------------------------------------------------------------

describe("YamlContextAnalyzer.findServiceReferences", () => {
  it("finds service: domain.action references", () => {
    const doc = createDoc("service: light.turn_on");
    const refs = analyzer.findServiceReferences(doc);
    expect(refs.length).toBe(1);
    expect(refs[0].service).toBe("light.turn_on");
  });

  it("finds action: domain.action references", () => {
    const doc = createDoc("action: notify.mobile_app");
    const refs = analyzer.findServiceReferences(doc);
    expect(refs.length).toBe(1);
    expect(refs[0].service).toBe("notify.mobile_app");
  });

  it("returns empty for no service references", () => {
    const doc = createDoc("alias: Test");
    expect(analyzer.findServiceReferences(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findIncludeReferences
// ---------------------------------------------------------------------------

describe("YamlContextAnalyzer.findIncludeReferences", () => {
  it("finds !include file references", () => {
    const doc = createDoc("automation: !include automations.yaml");
    const refs = analyzer.findIncludeReferences(doc);
    expect(refs.length).toBe(1);
    expect(refs[0].path).toBe("automations.yaml");
  });

  it("finds multiple !include references", () => {
    const doc = createDoc(
      "sensor: !include sensors.yaml\nautomation: !include automations.yaml"
    );
    const refs = analyzer.findIncludeReferences(doc);
    expect(refs.length).toBe(2);
  });

  it("returns empty when no !include present", () => {
    const doc = createDoc("key: value");
    expect(analyzer.findIncludeReferences(doc)).toEqual([]);
  });
});
