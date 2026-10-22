import { describe, expect, it } from "vitest";
import { recallDecisionPage, DECISION_RECALL_BUDGET_BYTES } from "../lib/decision-recall.js";

const note = (i, extra = {}) => ({ id: `note-${i}`, date: "2026-10-01", title: `Approved choice ${i}`,
  decision: "Keep this configuration.", status: "active", ...extra });
const state = (notes, revision = "fixture") => ({ ok: true, exists: true, notes, revision });

describe("bounded decision recall", () => {
  it("pages through more than 100 matches, without duplicate or missing IDs", () => {
    const current = state(Array.from({ length: 250 }, (_, i) => note(i)));
    const seen = [];
    let cursor;
    do {
      const result = recallDecisionPage(current, { limit: 100, ...(cursor ? { cursor } : {}) });
      expect(result.isError).toBeUndefined();
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DECISION_RECALL_BUDGET_BYTES);
      seen.push(...[...result.text.matchAll(/- id: `([^`]+)`/g)].map((match) => match[1]));
      cursor = result.page.next_cursor;
      expect(result.page.has_more).toBe(Boolean(cursor));
    } while (cursor);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });

  it("finds exact IDs even when relevance matches would hide them, including superseded notes", () => {
    const target = note(1, { id: "2026-07-01-heating", title: "Radiator design", status: "superseded", superseded_by: "new-choice" });
    const current = state([target, ...Array.from({ length: 30 }, (_, i) => note(i + 2, { title: target.id }))]);
    const result = recallDecisionPage(current, { id: target.id });
    expect(result.page.total_matched).toBe(1);
    expect(result.text).toContain("Radiator design");
    expect(result.text).toContain("status: superseded");
    expect(result.text).toContain("superseded by: `new-choice`");
    expect(recallDecisionPage(current, { id: target.id, query: "heating" }).isError).toBe(true);
  });

  it("combines exact entity/file/integration filters and leaves history opt-in for search", () => {
    const current = state([
      note(1, { entities: ["light.hall"], files: ["packages/lights.yaml"], integrations: ["hue"] }),
      note(2, { entities: ["light.hall"], files: ["packages/other.yaml"], integrations: ["hue"] }),
      note(3, { entities: ["light.hall"], files: ["packages/lights.yaml"], integrations: ["hue"], status: "superseded" }),
    ]);
    const filters = { entity: "light.hall", file: "packages/lights.yaml", integration: "hue" };
    expect(recallDecisionPage(current, filters).page.total_matched).toBe(1);
    expect(recallDecisionPage(current, { ...filters, include_superseded: true }).page.total_matched).toBe(2);
  });

  it("rejects stale or malformed cursors and changed filters or page limits", () => {
    const current = state([note(1), note(2)]);
    const cursor = recallDecisionPage(current, { limit: 1 }).page.next_cursor;
    expect(recallDecisionPage({ ...current, revision: "changed" }, { cursor, limit: 1 }).text).toContain("Restart recall");
    for (const args of [{ cursor, limit: 2 }, { cursor, limit: 1, query: "choice" }, { cursor: "../bad", limit: 1 },
      { cursor: "e30", limit: 1 }, { limit: 0 }, { limit: 1.5 }]) {
      expect(recallDecisionPage(current, args).isError).toBe(true);
    }
  });

  it("invalidates pagination when secret screening changes even if the YAML revision does not", () => {
    const current = state([note(1, { rationale: "A local comparison value abc123SUPERSECRET456." }), note(2), note(3)]);
    const cursor = recallDecisionPage(current, { limit: 1 }).page.next_cursor;
    const result = recallDecisionPage(current, { cursor, limit: 1 }, ["abc123SUPERSECRET456"]);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("abc123SUPERSECRET456");
  });

  it("enforces the byte budget for multibyte notes and explicitly skips oversized notes without blocking later pages", () => {
    const current = state([note(1, { date: "2026-10-22", title: "測定".repeat(4000) }), note(2, { decision: "保持".repeat(200) }), note(3)]);
    const first = recallDecisionPage(current, { limit: 1 });
    expect(first.page.oversized).toBe(1);
    expect(first.text).toContain("contents were NOT returned");
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(8192);
    let cursor = first.page.next_cursor;
    const shown = [];
    while (cursor) {
      const next = recallDecisionPage(current, { limit: 1, cursor });
      expect(Buffer.byteLength(next.text)).toBeLessThanOrEqual(8192);
      shown.push(next.text);
      cursor = next.page.next_cursor;
    }
    expect(shown.join("\n")).toContain("Approved choice 2");
  });

  it("screens IDs and replacement links as well as note content, including exact lookups", () => {
    const current = state([note(1, { superseded_by: "Bearer abcdefghijklmnopqrstuvwxyz123456" }), note(2)]);
    const result = recallDecisionPage(current, { id: "note-1" });
    expect(result.page.returned).toBe(0);
    expect(result.text).toContain("withheld");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("keeps unavailable/partial/withheld records distinct from an absence of decisions", () => {
    expect(recallDecisionPage({ ok: false, exists: true, notes: [] }).isError).toBe(true);
    const partial = recallDecisionPage({ ...state([note(1)]), ok: false });
    expect(partial.text).toContain("incomplete readable subset");
    expect(partial.text).toContain("Approved choice 1");
    const history = recallDecisionPage(state([note(1, { status: "superseded" })]));
    expect(history.text).toContain("include_superseded");
    expect(history.text).not.toContain("No decision notes have been recorded");
  });
});
