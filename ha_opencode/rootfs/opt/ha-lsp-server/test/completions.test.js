import { describe, it, expect } from "vitest";
import {
  getTriggerPlatformCompletions,
  getConditionTypeCompletions,
  getKeyCompletions,
  getWordRangeAtPosition,
} from "../lib/completions.js";

/**
 * Fake CompletionItemKind matching the vscode-languageserver enum values.
 * We only need the subset our functions reference.
 */
const CompletionItemKind = {
  EnumMember: 20,
  Property: 10,
};

// ---------------------------------------------------------------------------
// getTriggerPlatformCompletions
// ---------------------------------------------------------------------------

describe("getTriggerPlatformCompletions", () => {
  it("returns an array of trigger platform completions", () => {
    const items = getTriggerPlatformCompletions(CompletionItemKind);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.kind === CompletionItemKind.EnumMember)).toBe(true);
  });

  it("includes well-known platforms", () => {
    const items = getTriggerPlatformCompletions(CompletionItemKind);
    const labels = items.map(i => i.label);
    expect(labels).toContain("state");
    expect(labels).toContain("time");
    expect(labels).toContain("mqtt");
    expect(labels).toContain("webhook");
    expect(labels).toContain("event");
    expect(labels).toContain("template");
  });

  it("sets insertText equal to label for each item", () => {
    const items = getTriggerPlatformCompletions(CompletionItemKind);
    for (const item of items) {
      expect(item.insertText).toBe(item.label);
    }
  });
});

// ---------------------------------------------------------------------------
// getConditionTypeCompletions
// ---------------------------------------------------------------------------

describe("getConditionTypeCompletions", () => {
  it("returns an array of condition completions", () => {
    const items = getConditionTypeCompletions(CompletionItemKind);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.kind === CompletionItemKind.EnumMember)).toBe(true);
  });

  it("includes logical operators and, or, not", () => {
    const labels = getConditionTypeCompletions(CompletionItemKind).map(i => i.label);
    expect(labels).toContain("and");
    expect(labels).toContain("or");
    expect(labels).toContain("not");
  });
});

// ---------------------------------------------------------------------------
// getKeyCompletions
// ---------------------------------------------------------------------------

describe("getKeyCompletions", () => {
  it("returns automation keys at root level", () => {
    const context = { parentKeys: [], parentKey: null };
    const items = getKeyCompletions(context, CompletionItemKind);
    const labels = items.map(i => i.label);
    expect(labels).toContain("alias");
    expect(labels).toContain("trigger");
    expect(labels).toContain("action");
    expect(labels).toContain("mode");
  });

  it("returns trigger keys when inside a trigger block", () => {
    const context = { parentKeys: ["automation", "trigger"], parentKey: "trigger" };
    const items = getKeyCompletions(context, CompletionItemKind);
    const labels = items.map(i => i.label);
    expect(labels).toContain("platform");
    expect(labels).toContain("entity_id");
    expect(labels).toContain("to");
    expect(labels).toContain("from");
  });

  it("returns action keys when inside an action block", () => {
    const context = { parentKeys: ["automation", "action"], parentKey: "action" };
    const items = getKeyCompletions(context, CompletionItemKind);
    const labels = items.map(i => i.label);
    expect(labels).toContain("service");
    expect(labels).toContain("target");
    expect(labels).toContain("data");
    expect(labels).toContain("delay");
    expect(labels).toContain("choose");
  });

  it("includes both automation AND trigger keys when inside trigger", () => {
    // Because parentKeys[0] === "automation", automation keys are also included
    const context = { parentKeys: ["automation", "trigger"], parentKey: "trigger" };
    const items = getKeyCompletions(context, CompletionItemKind);
    const labels = items.map(i => i.label);
    // Automation keys
    expect(labels).toContain("alias");
    // Trigger keys
    expect(labels).toContain("platform");
  });

  it("returns empty for unrecognized context", () => {
    const context = { parentKeys: ["something_else"], parentKey: "something_else" };
    const items = getKeyCompletions(context, CompletionItemKind);
    expect(items).toEqual([]);
  });

  it("appends ': ' to insertText for property keys", () => {
    const context = { parentKeys: [], parentKey: null };
    const items = getKeyCompletions(context, CompletionItemKind);
    for (const item of items) {
      expect(item.insertText).toBe(`${item.label}: `);
    }
  });
});

// ---------------------------------------------------------------------------
// getWordRangeAtPosition
// ---------------------------------------------------------------------------

describe("getWordRangeAtPosition", () => {
  /** Minimal TextDocument mock */
  function createDoc(text) {
    const lines = text.split("\n");
    const lineOffsets = [0];
    for (let i = 0; i < lines.length; i++) {
      lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
    }
    const doc = {
      getText(range) {
        if (!range) return text;
        const start = doc.offsetAt(range.start);
        const end = doc.offsetAt(range.end);
        return text.substring(start, end);
      },
      offsetAt(pos) { return lineOffsets[pos.line] + pos.character; },
      positionAt(offset) {
        for (let i = 0; i < lineOffsets.length - 1; i++) {
          if (offset < lineOffsets[i + 1]) {
            return { line: i, character: offset - lineOffsets[i] };
          }
        }
        const last = lineOffsets.length - 1;
        return { line: last, character: offset - lineOffsets[last] };
      },
    };
    return doc;
  }

  it("returns range for a simple word", () => {
    const doc = createDoc("hello world");
    const range = getWordRangeAtPosition(doc, { line: 0, character: 1 });
    expect(range).not.toBeNull();
    expect(doc.getText(range)).toBe("hello");
  });

  it("includes dots for entity IDs", () => {
    const doc = createDoc("entity_id: light.living_room");
    // cursor on 'l' of 'light'
    const range = getWordRangeAtPosition(doc, { line: 0, character: 12 });
    expect(range).not.toBeNull();
    expect(doc.getText(range)).toBe("light.living_room");
  });

  it("includes dots for service calls", () => {
    const doc = createDoc("service: notify.mobile_app_phone");
    const range = getWordRangeAtPosition(doc, { line: 0, character: 15 });
    expect(range).not.toBeNull();
    expect(doc.getText(range)).toBe("notify.mobile_app_phone");
  });

  it("returns null for whitespace position", () => {
    const doc = createDoc("hello   world");
    const range = getWordRangeAtPosition(doc, { line: 0, character: 6 });
    expect(range).toBeNull();
  });

  it("returns null for empty document", () => {
    const doc = createDoc("");
    const range = getWordRangeAtPosition(doc, { line: 0, character: 0 });
    expect(range).toBeNull();
  });
});
