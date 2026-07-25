import { describe, it, expect } from "vitest";
import {
  DECISION_DIGEST_BUDGET_BYTES,
  LIMITS,
  activeNotes,
  addNote,
  buildNoteId,
  parseDecisionNotes,
  renderDecisionDigest,
  searchNotes,
  serializeDecisionNotes,
  slugify,
  supersedeNotes,
} from "../lib/decision-notes.js";
import { byteLength } from "../lib/context-budget.js";

const NOW = new Date("2026-07-26T12:00:00Z");

function emptyState() {
  return { version: 1, notes: [] };
}

function stateWith(...notes) {
  return { version: 1, notes };
}

function sampleNote(overrides = {}) {
  return {
    id: "2026-07-01-tc71-privacy-toggle",
    date: "2026-07-01",
    title: "TC71 privacy toggle is an inverted template switch",
    decision: "The dashboard toggle uses switch.tc71_privacy_mode, which inverts switch.tc71_cam_1.",
    status: "active",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slugify / buildNoteId
// ---------------------------------------------------------------------------

describe("buildNoteId", () => {
  it("builds a readable, date-prefixed id", () => {
    expect(buildNoteId("TC71 privacy toggle", "2026-07-26")).toBe("2026-07-26-tc71-privacy-toggle");
  });

  it("resolves collisions deterministically", () => {
    const existing = new Set(["2026-07-26-lights", "2026-07-26-lights-2"]);
    expect(buildNoteId("Lights", "2026-07-26", existing)).toBe("2026-07-26-lights-3");
  });

  it("falls back when a title has no usable characters", () => {
    expect(buildNoteId("!!!", "2026-07-26")).toBe("2026-07-26-note");
  });

  it("never ends with a separator after truncation", () => {
    const id = buildNoteId("a".repeat(30) + " " + "b".repeat(30), "2026-07-26");
    expect(id.endsWith("-")).toBe(false);
  });

  it("truncates long titles on a word boundary", () => {
    const id = buildNoteId("TC71 privacy toggle is an inverted template switch", "2026-07-26");
    expect(id).toBe("2026-07-26-tc71-privacy-toggle-is-an-inverted");
  });
});

describe("slugify", () => {
  it("normalizes punctuation and case", () => {
    expect(slugify("Don't touch the Node-RED automations!")).toBe("don-t-touch-the-node-red-automations");
  });
});

// ---------------------------------------------------------------------------
// parse / serialize round trip
// ---------------------------------------------------------------------------

describe("parseDecisionNotes", () => {
  it("treats an empty or absent file as an empty set", () => {
    for (const input of ["", "   ", null, undefined]) {
      const result = parseDecisionNotes(input);
      expect(result.ok).toBe(true);
      expect(result.notes).toEqual([]);
    }
  });

  it("round-trips through serialize", () => {
    const state = stateWith(
      sampleNote({ rationale: "Matches the vendor app.", entities: ["switch.tc71_cam_1"], files: ["packages/tc71.yaml"] }),
    );
    const parsed = parseDecisionNotes(serializeDecisionNotes(state));
    expect(parsed.ok).toBe(true);
    expect(parsed.notes).toEqual(state.notes);
  });

  it("keeps the explanatory header comment in the serialized file", () => {
    const text = serializeDecisionNotes(emptyState());
    expect(text).toContain("# OpenCode decision notes");
    expect(text).toContain("Safe to edit or delete by hand");
  });

  it("reports invalid YAML instead of throwing", () => {
    const result = parseDecisionNotes("notes:\n  - title: 'unterminated\n");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not valid YAML");
    expect(result.notes).toEqual([]);
  });

  it("reports a missing required field and keeps the valid notes readable", () => {
    const yaml = [
      "version: 1",
      "notes:",
      "  - id: good",
      "    date: 2026-07-01",
      "    title: Good note",
      "    decision: Something was decided.",
      "  - id: bad",
      "    date: 2026-07-02",
      "    title: Missing decision",
    ].join("\n");
    const result = parseDecisionNotes(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("'decision' is required");
    expect(result.notes).toHaveLength(1);
  });

  it("rejects a document that is not a mapping", () => {
    expect(parseDecisionNotes("- just\n- a\n- list\n").ok).toBe(false);
  });

  it("flags duplicate ids", () => {
    const yaml = [
      "notes:",
      "  - id: dup",
      "    date: 2026-07-01",
      "    title: One",
      "    decision: First.",
      "  - id: dup",
      "    date: 2026-07-02",
      "    title: Two",
      "    decision: Second.",
    ].join("\n");
    const result = parseDecisionNotes(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate id");
  });

  it("defaults an unknown status to active", () => {
    const yaml = [
      "notes:",
      "  - id: a",
      "    date: 2026-07-01",
      "    title: A",
      "    decision: B.",
      "    status: nonsense",
    ].join("\n");
    expect(parseDecisionNotes(yaml).notes[0].status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// addNote
// ---------------------------------------------------------------------------

describe("addNote", () => {
  it("adds a note with a generated id and today's date", () => {
    const result = addNote(emptyState(), { title: "Use packages", decision: "New config goes in packages/." }, { now: NOW });
    expect(result.error).toBeUndefined();
    expect(result.note.id).toBe("2026-07-26-use-packages");
    expect(result.note.date).toBe("2026-07-26");
    expect(result.note.status).toBe("active");
    expect(result.state.notes).toHaveLength(1);
  });

  it("returns the serialized file so the caller writes exactly what was validated", () => {
    const result = addNote(emptyState(), { title: "T", decision: "D." }, { now: NOW });
    expect(parseDecisionNotes(result.serialized).notes).toEqual(result.state.notes);
  });

  it("requires a title and a decision", () => {
    expect(addNote(emptyState(), { decision: "D." }, { now: NOW }).error).toContain("title");
    expect(addNote(emptyState(), { title: "T" }, { now: NOW }).error).toContain("decision");
  });

  it("refuses a decision that is too long, pointing at rationale", () => {
    const result = addNote(emptyState(), { title: "T", decision: "x".repeat(LIMITS.decision + 1) }, { now: NOW });
    expect(result.error).toContain("rationale");
  });

  it("normalizes whitespace in stored text", () => {
    const result = addNote(emptyState(), { title: "  Spaced   out  ", decision: "A\n\nB." }, { now: NOW });
    expect(result.note.title).toBe("Spaced out");
    expect(result.note.decision).toBe("A B.");
  });

  it("refuses a note containing credentials", () => {
    const result = addNote(
      emptyState(),
      { title: "MQTT broker", decision: "The broker password is hunter2hunter2 for user admin." },
      { now: NOW },
    );
    expect(result.error).toContain("credentials must not go in them");
    expect(result.state).toBeUndefined();
  });

  it("refuses a note reusing a value from secrets.yaml", () => {
    const result = addNote(
      emptyState(),
      { title: "Broker", decision: "Connects using swordfish99 as configured." },
      { now: NOW, secretValues: ["swordfish99"] },
    );
    expect(result.error).toContain("secrets.yaml");
  });

  it("allows a !secret reference", () => {
    const result = addNote(
      emptyState(),
      { title: "Broker", decision: "Credentials come from !secret mqtt_password." },
      { now: NOW, secretValues: ["swordfish99"] },
    );
    expect(result.error).toBeUndefined();
  });

  it("blocks a duplicate active title and suggests superseding", () => {
    const existing = addNote(emptyState(), { title: "Use packages", decision: "A." }, { now: NOW });
    const duplicate = addNote(existing.state, { title: "use PACKAGES", decision: "B." }, { now: NOW });
    expect(duplicate.error).toContain("supersedes");
    expect(duplicate.error).toContain(existing.note.id);
  });

  it("supersedes an existing note and links both directions", () => {
    const first = addNote(emptyState(), { title: "Use packages", decision: "A." }, { now: NOW });
    const second = addNote(
      first.state,
      { title: "Use packages", decision: "B.", supersedes: [first.note.id] },
      { now: NOW },
    );
    expect(second.error).toBeUndefined();
    const superseded = second.state.notes.find((note) => note.id === first.note.id);
    expect(superseded.status).toBe("superseded");
    expect(superseded.superseded_by).toBe(second.note.id);
    expect(activeNotes(second.state.notes)).toHaveLength(1);
  });

  it("refuses to supersede an unknown id", () => {
    const result = addNote(emptyState(), { title: "T", decision: "D.", supersedes: ["nope"] }, { now: NOW });
    expect(result.error).toContain("unknown note id");
  });

  it("enforces the active-note cap and explains how to proceed", () => {
    let state = emptyState();
    for (let i = 0; i < LIMITS.maxActive; i += 1) {
      const result = addNote(state, { title: `Note ${i}`, decision: `Decision ${i}.` }, { now: NOW });
      expect(result.error).toBeUndefined();
      state = result.state;
    }
    const overflow = addNote(state, { title: "One too many", decision: "D." }, { now: NOW });
    expect(overflow.error).toContain("supersede");
    expect(overflow.state).toBeUndefined();
  });

  it("still accepts a note that supersedes another once at the cap", () => {
    let state = emptyState();
    let firstId = null;
    for (let i = 0; i < LIMITS.maxActive; i += 1) {
      const result = addNote(state, { title: `Note ${i}`, decision: `Decision ${i}.` }, { now: NOW });
      state = result.state;
      if (i === 0) firstId = result.note.id;
    }
    const replacement = addNote(state, { title: "Replacement", decision: "D.", supersedes: [firstId] }, { now: NOW });
    expect(replacement.error).toBeUndefined();
  });

  it("caps and de-duplicates reference lists", () => {
    const result = addNote(
      emptyState(),
      {
        title: "T",
        decision: "D.",
        entities: ["light.a", "light.a", ...Array.from({ length: 30 }, (_, i) => `light.x${i}`)],
      },
      { now: NOW },
    );
    expect(result.note.entities).toHaveLength(LIMITS.maxRefs);
    expect(new Set(result.note.entities).size).toBe(LIMITS.maxRefs);
  });
});

// ---------------------------------------------------------------------------
// supersedeNotes
// ---------------------------------------------------------------------------

describe("supersedeNotes", () => {
  it("marks a note superseded without deleting it", () => {
    const state = stateWith(sampleNote());
    const result = supersedeNotes(state, [state.notes[0].id]);
    expect(result.error).toBeUndefined();
    expect(result.state.notes).toHaveLength(1);
    expect(result.state.notes[0].status).toBe("superseded");
  });

  it("rejects unknown ids", () => {
    expect(supersedeNotes(stateWith(sampleNote()), ["nope"]).error).toContain("Unknown note id");
  });

  it("rejects an empty id list", () => {
    expect(supersedeNotes(stateWith(sampleNote()), []).error).toContain("at least one note id");
  });

  it("reports when everything requested is already superseded", () => {
    const state = stateWith(sampleNote({ status: "superseded" }));
    expect(supersedeNotes(state, [state.notes[0].id]).error).toContain("already superseded");
  });
});

// ---------------------------------------------------------------------------
// searchNotes
// ---------------------------------------------------------------------------

describe("searchNotes", () => {
  const state = stateWith(
    sampleNote({ id: "a", date: "2026-07-01", title: "Zigbee stack", decision: "We use ZHA.", entities: ["light.hall"] }),
    sampleNote({ id: "b", date: "2026-07-05", title: "Node-RED", decision: "Leave those automations alone." }),
    sampleNote({ id: "c", date: "2026-07-03", title: "Old choice", decision: "Superseded.", status: "superseded" }),
  );

  it("returns active notes newest first by default", () => {
    expect(searchNotes(state.notes).map((note) => note.id)).toEqual(["b", "a"]);
  });

  it("matches on decision text and references", () => {
    expect(searchNotes(state.notes, { query: "zha" }).map((n) => n.id)).toEqual(["a"]);
    expect(searchNotes(state.notes, { query: "light.hall" }).map((n) => n.id)).toEqual(["a"]);
  });

  it("includes superseded notes only when asked", () => {
    expect(searchNotes(state.notes, { includeSuperseded: true })).toHaveLength(3);
  });

  it("honors the limit", () => {
    expect(searchNotes(state.notes, { limit: 1 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// renderDecisionDigest
// ---------------------------------------------------------------------------

describe("renderDecisionDigest", () => {
  it("renders nothing when there are no active notes", () => {
    expect(renderDecisionDigest([]).markdown).toBe("");
    expect(renderDecisionDigest([sampleNote({ status: "superseded" })]).markdown).toBe("");
  });

  it("includes only active notes, newest first", () => {
    const notes = [
      sampleNote({ id: "old", date: "2026-07-01", title: "Old" }),
      sampleNote({ id: "new", date: "2026-07-20", title: "New" }),
      sampleNote({ id: "gone", date: "2026-07-25", title: "Gone", status: "superseded" }),
    ];
    const result = renderDecisionDigest(notes);
    expect(result.includedNotes).toEqual(["new", "old"]);
    expect(result.markdown).not.toContain("Gone");
  });

  it("omits the rationale, which stays retrievable via recall_decisions", () => {
    const notes = [sampleNote({ rationale: "A very specific historical reason." })];
    const result = renderDecisionDigest(notes);
    expect(result.markdown).not.toContain("historical reason");
    expect(result.markdown).toContain("recall_decisions");
  });

  it("stays inside the budget and says what it dropped", () => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      sampleNote({
        id: `n${i}`,
        date: "2026-07-01",
        title: `Decision number ${i} with a fairly long descriptive title`,
        decision: "x".repeat(300),
      }),
    );
    const result = renderDecisionDigest(notes);
    expect(byteLength(result.markdown)).toBeLessThanOrEqual(DECISION_DIGEST_BUDGET_BYTES + 1);
    expect(result.droppedNotes.length).toBeGreaterThan(0);
    expect(result.markdown).toContain("omitted to stay within the context budget");
  });

  it("tells the model to raise a conflict rather than silently reversing a decision", () => {
    const result = renderDecisionDigest([sampleNote()]);
    expect(result.markdown).toContain("say so before acting");
  });

  it("renders each note as a single list item", () => {
    const notes = [sampleNote({ id: "a", title: "A" }), sampleNote({ id: "b", title: "B" })];
    const bullets = renderDecisionDigest(notes).markdown.split("\n").filter((line) => line.startsWith("- **"));
    expect(bullets).toHaveLength(2);
  });
});
