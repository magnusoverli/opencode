import { describe, it, expect } from "vitest";
import {
  DECISION_DIGEST_BUDGET_BYTES,
  LIMITS,
  activeNotes,
  addNote,
  buildNoteId,
  parseDecisionNotes,
  renderDecisionDigest,
  screenNotesForSecrets,
  searchNoteMatches,
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

  // The parse error goes to the model, and a file that is broken *because*
  // someone pasted a credential into it cannot be screened — it does not parse.
  it("does not echo the offending line back when the file will not parse", () => {
    const broken = ['version: 1', 'notes:', '  - id: a', '    decision: "the token is sk-live-ABC123SECRET'].join("\n");
    const result = parseDecisionNotes(broken);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).not.toContain("ABC123SECRET");
    expect(result.errors[0]).toMatch(/line \d+/);
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

  // Reading `status: retired` as "active" would put a decision the user retired
  // back into every session's prompt — a silent reversal, which is the failure
  // this whole feature exists to prevent. It has to be an error, not a default.
  it("refuses an unrecognized status instead of treating it as active", () => {
    const yaml = [
      "notes:",
      "  - id: a",
      "    date: 2026-07-01",
      "    title: A",
      "    decision: B.",
      "    status: retired",
    ].join("\n");

    const result = parseDecisionNotes(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("'status' must be 'active' or 'superseded'");
    expect(result.notes).toHaveLength(0);
  });

  it("treats a missing status as active", () => {
    const yaml = ["notes:", "  - id: a", "    date: 2026-07-01", "    title: A", "    decision: B."].join("\n");
    const result = parseDecisionNotes(yaml);
    expect(result.ok).toBe(true);
    expect(result.notes[0].status).toBe("active");
  });

  it("preserves hand-written text rather than truncating it back into the file", () => {
    const long = "L".repeat(LIMITS.decision + 200);
    const yaml = ["notes:", "  - id: a", "    date: 2026-07-01", "    title: A", `    decision: ${long}`].join("\n");

    const parsed = parseDecisionNotes(yaml);
    expect(parsed.notes[0].decision).toHaveLength(long.length);
    expect(serializeDecisionNotes(parsed)).toContain(long);
  });

  it("carries the user's own keys through a rewrite", () => {
    const yaml = [
      "notes:",
      "  - id: a",
      "    date: 2026-07-01",
      "    title: A",
      "    decision: B.",
      "    owner: magnus",
      "    ticket: 42",
    ].join("\n");

    const rewritten = serializeDecisionNotes(parseDecisionNotes(yaml));
    expect(rewritten).toContain("owner: magnus");
    expect(rewritten).toContain("ticket: 42");
  });
});

// ---------------------------------------------------------------------------
// date stamping
// ---------------------------------------------------------------------------

describe("note dates", () => {
  // The add-on runs in the Home Assistant time zone. Stamping in UTC dates a
  // note recorded just after midnight to yesterday, and an evening note in the
  // Americas to tomorrow — which then sorts to the top of the digest forever.
  it("uses the local calendar date, not UTC", () => {
    const justAfterLocalMidnight = new Date(2026, 6, 28, 0, 30);
    const result = addNote(emptyState(), { title: "T", decision: "D." }, { now: justAfterLocalMidnight });
    expect(result.note.date).toBe("2026-07-28");
    expect(result.note.id.startsWith("2026-07-28-")).toBe(true);
  });

  it("never stamps a date in the future", () => {
    const lateEvening = new Date(2026, 6, 27, 23, 45);
    expect(addNote(emptyState(), { title: "T", decision: "D." }, { now: lateEvening }).note.date).toBe("2026-07-27");
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

  // Silently keeping the first twelve of fifteen ids would leave three retired
  // constraints active in the prompt while reporting success.
  it("retires every id it is given, not the first handful", () => {
    let state = emptyState();
    for (let i = 0; i < 15; i += 1) {
      state = addNote(state, { title: `Note ${i}`, decision: `D${i}.` }, { now: NOW }).state;
    }
    const ids = state.notes.map((note) => note.id);

    const result = supersedeNotes(state, ids);

    expect(result.error).toBeUndefined();
    expect(result.superseded).toHaveLength(ids.length);
    expect(activeNotes(result.state.notes)).toHaveLength(0);
  });

  it("supersedes every id passed to addNote as well", () => {
    let state = emptyState();
    for (let i = 0; i < 15; i += 1) {
      state = addNote(state, { title: `Note ${i}`, decision: `D${i}.` }, { now: NOW }).state;
    }
    const ids = state.notes.map((note) => note.id);

    const result = addNote(state, { title: "Replaces all", decision: "D.", supersedes: ids }, { now: NOW });

    expect(result.error).toBeUndefined();
    expect(activeNotes(result.state.notes).map((note) => note.title)).toEqual(["Replaces all"]);
  });

  it("reports notes that were already superseded instead of claiming to retire them", () => {
    const state = stateWith(
      sampleNote({ id: "live" }),
      sampleNote({ id: "gone", title: "Gone", status: "superseded" }),
    );
    const result = supersedeNotes(state, ["live", "gone"]);
    expect(result.superseded).toEqual(["live"]);
    expect(result.alreadySuperseded).toEqual(["gone"]);
  });

  it("does not overwrite an existing superseded_by link", () => {
    const state = stateWith(sampleNote({ id: "a", status: "superseded", superseded_by: "original" }));
    const result = supersedeNotes(state, ["a"], { supersededBy: "later" });
    expect(result.error).toContain("already superseded");
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

  // recall_decisions is what makes the small always-on digest safe. A query that
  // misses a note that exists does not read as "search failed" — it reads as
  // "no such decision was made", which is the one wrong answer this must avoid.
  describe("natural-language recall", () => {
    const notes = stateWith(
      sampleNote({
        id: "tc71",
        date: "2026-07-25",
        title: "TC71 privacy mode toggle is inverted",
        decision: "switch.tc71_privacy_mode inverts switch.tc71_cam_1 so ON means privacy engaged.",
        rationale: "Matches the Tapo app, where the control means privacy rather than power.",
        entities: ["switch.tc71_cam_1"],
      }),
      sampleNote({
        id: "nodered",
        date: "2026-07-01",
        title: "Node-RED automations are off limits",
        decision: "Leave the Node-RED flows alone.",
      }),
    ).notes;

    it.each([
      ["camera privacy", "tc71"],
      ["why is the camera toggle inverted", "tc71"],
      ["inverted cameras", "tc71"],
      ["tapo", "tc71"],
      ["switch.tc71_cam_1", "tc71"],
      ["node-red flows", "nodered"],
    ])("finds the right note for %j", (query, expected) => {
      expect(searchNotes(notes, { query }).map((note) => note.id)[0]).toBe(expected);
    });

    it("ranks the better match first rather than returning by date", () => {
      expect(searchNotes(notes, { query: "privacy toggle" })[0].id).toBe("tc71");
    });

    it("returns nothing only when nothing is related", () => {
      expect(searchNotes(notes, { query: "washing machine descaling" })).toHaveLength(0);
    });

    it("lists everything when a query carries no searchable words", () => {
      expect(searchNotes(notes, { query: "why is it" })).toHaveLength(2);
    });

    it("reports how many matched, not just how many were returned", () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        sampleNote({ id: `n${i}`, title: `Heating schedule ${i}`, decision: "Leave it." }),
      );
      const result = searchNoteMatches(many, { query: "heating" });
      expect(result.matches).toHaveLength(20);
      expect(result.totalMatched).toBe(30);
      expect(result.truncated).toBe(true);
    });

    it("ignores a nonsense limit rather than returning nothing", () => {
      expect(searchNotes(notes, { query: "privacy", limit: "lots" })).toHaveLength(1);
      expect(searchNotes(notes, { query: "privacy", limit: 0 })).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// secret screening on the read path
// ---------------------------------------------------------------------------

describe("screening notes on their way to the model", () => {
  // addNote screens what it writes, but decisions.yaml is documented as
  // hand-editable — the guarantee has to hold for text nobody screened on write.
  const handEdited = sampleNote({
    id: "hand-edited",
    title: "MQTT broker access",
    decision: "The broker password is hunter2hunter2 for the admin user.",
  });

  it("keeps a hand-written credential out of the digest", () => {
    const result = renderDecisionDigest([handEdited, sampleNote({ id: "safe", title: "Safe" })]);
    expect(result.markdown).not.toContain("hunter2hunter2");
    expect(result.withheldNotes).toEqual(["hand-edited"]);
    expect(result.includedNotes).toEqual(["safe"]);
  });

  it("keeps a value from secrets.yaml out of the digest", () => {
    const note = sampleNote({ id: "leaky", decision: "Set the key to abc123SUPERSECRET456 in the config." });
    const result = renderDecisionDigest([note], { secretValues: ["abc123SUPERSECRET456"] });
    expect(result.markdown).not.toContain("abc123SUPERSECRET456");
    expect(result.withheldNotes).toEqual(["leaky"]);
  });

  it("says so rather than going quiet when every note is withheld", () => {
    const result = renderDecisionDigest([handEdited]);
    expect(result.markdown).toContain("withheld");
    expect(result.markdown).toContain("decisions.yaml");
    expect(result.markdown).not.toContain("hunter2hunter2");
    expect(result.includedNotes).toHaveLength(0);
  });

  it("reports withheld notes by id only, never by content", () => {
    const { safe, withheld } = screenNotesForSecrets([handEdited, sampleNote({ id: "safe" })]);
    expect(withheld).toEqual(["hand-edited"]);
    expect(safe.map((note) => note.id)).toEqual(["safe"]);
    expect(JSON.stringify(withheld)).not.toContain("hunter2hunter2");
  });

  it("screens the rationale too, since recall_decisions returns it", () => {
    const note = sampleNote({ id: "r", rationale: "The api_key is 9f8e7d6c5b4a3f2e1d0c9b8a for that service." });
    expect(screenNotesForSecrets([note]).withheld).toEqual(["r"]);
  });

  it("leaves ordinary notes alone", () => {
    const notes = [sampleNote({ id: "a" }), sampleNote({ id: "b", rationale: "The password is unchanged." })];
    expect(screenNotesForSecrets(notes).withheld).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pinning
// ---------------------------------------------------------------------------

describe("pinned notes", () => {
  it("round-trips a pin through serialize and parse", () => {
    const serialized = serializeDecisionNotes(stateWith(sampleNote({ pin: true })));
    expect(parseDecisionNotes(serialized).notes[0].pin).toBe(true);
  });

  it("accepts the spellings a person would hand-write", () => {
    const parsed = parseDecisionNotes(`version: 1
notes:
  - id: a
    date: 2026-07-01
    title: Hand written
    decision: Keep this.
    pin: "yes"
    status: active
`);
    expect(parsed.ok).toBe(true);
    expect(parsed.notes[0].pin).toBe(true);
  });

  it("records a pin requested through the tool", () => {
    const result = addNote(emptyState(), { title: "T", decision: "D.", pin: true }, { now: NOW });
    expect(result.note.pin).toBe(true);
  });

  it("leaves a note unpinned by default", () => {
    expect(addNote(emptyState(), { title: "T", decision: "D." }, { now: NOW }).note.pin).toBeUndefined();
  });

  it("caps how many notes can be pinned and explains the choice", () => {
    let state = emptyState();
    for (let i = 0; i < LIMITS.maxPinned; i += 1) {
      const result = addNote(state, { title: `Pinned ${i}`, decision: "D.", pin: true }, { now: NOW });
      expect(result.error).toBeUndefined();
      state = result.state;
    }
    const overflow = addNote(state, { title: "One too many", decision: "D.", pin: true }, { now: NOW });
    expect(overflow.error).toContain("pinned");
    expect(overflow.state).toBeUndefined();

    // The same note without a pin is still perfectly recordable.
    expect(addNote(state, { title: "One too many", decision: "D." }, { now: NOW }).error).toBeUndefined();
  });

  it("does not count a pinned note that this one supersedes", () => {
    let state = emptyState();
    let firstId = null;
    for (let i = 0; i < LIMITS.maxPinned; i += 1) {
      const result = addNote(state, { title: `Pinned ${i}`, decision: "D.", pin: true }, { now: NOW });
      state = result.state;
      if (i === 0) firstId = result.note.id;
    }
    const replacement = addNote(
      state,
      { title: "Replacement", decision: "D.", pin: true, supersedes: [firstId] },
      { now: NOW },
    );
    expect(replacement.error).toBeUndefined();
    expect(replacement.note.pin).toBe(true);
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

  it("says so explicitly when the list is complete", () => {
    const result = renderDecisionDigest([sampleNote({ id: "a" }), sampleNote({ id: "b", title: "Second" })]);
    expect(result.droppedNotes).toHaveLength(0);
    expect(result.markdown).toContain("All 2 active notes");
    expect(result.markdown).toContain("nothing had been left out");
  });

  // The digest is rebuilt at add-on start and on `ha-context refresh`, not when
  // a note is recorded, so it can be a snapshot older than the notes file. An
  // unbounded completeness claim would then be false in the one direction that
  // causes damage: a decision the user made reading as a decision never made.
  it("bounds the completeness claim to when the summary was built", () => {
    const result = renderDecisionDigest([sampleNote({ id: "a" })]);
    expect(result.markdown).toContain("when this summary was built");
    expect(result.markdown).toContain("Notes recorded since are in force");
    expect(result.markdown).toContain("recall_decisions");
  });

  // "Nothing has been left out" must not be asserted in the same breath as
  // "some notes were withheld" — that is the silent-gap failure one level up.
  it("does not claim completeness when notes were withheld or unreadable", () => {
    const leaky = sampleNote({ id: "leak", decision: "The broker password is hunter2hunter2 for admin." });
    const withheld = renderDecisionDigest([sampleNote({ id: "ok" }), leaky]);
    expect(withheld.markdown).not.toContain("nothing has been left out");
    expect(withheld.markdown).toContain("withheld");

    const unreadable = renderDecisionDigest([sampleNote({ id: "ok" })], { unreadable: 2 });
    expect(unreadable.markdown).not.toContain("nothing has been left out");
    expect(unreadable.markdown).toContain("could not be read");
    expect(unreadable.markdown).toContain("recall_decisions");
  });

  it("keeps a note's references visible even when none of them fit the line", () => {
    const note = sampleNote({ id: "long-ref", entities: [`sensor.${"x".repeat(200)}`] });
    const line = renderDecisionDigest([note]).markdown.split("\n").find((l) => l.startsWith("- **"));
    expect(line).toContain("1 reference");
    expect(line).toContain("recall_decisions");
  });

  // The failure this guards against is silent truncation: a note dropped for
  // space reads exactly like a decision that was never made, and the model then
  // "fixes" a deliberate configuration. Every length band has to declare it.
  it.each([40, 80, 160, 320])("never drops a note silently (%i-char decisions)", (decisionLength) => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      sampleNote({
        id: `n${i}`,
        date: "2026-07-01",
        title: `Decision number ${i} with a fairly long descriptive title`,
        decision: "x".repeat(decisionLength),
      }),
    );

    const result = renderDecisionDigest(notes);

    expect(byteLength(result.markdown)).toBeLessThanOrEqual(DECISION_DIGEST_BUDGET_BYTES);
    expect(result.droppedNotes.length).toBeGreaterThan(0);
    expect(result.includedNotes.length + result.droppedNotes.length).toBe(result.totalActive);
    expect(result.markdown).toContain(
      `Listing ${result.includedNotes.length} of ${result.totalActive} active notes`,
    );
    expect(result.markdown).toContain("are NOT shown below");
    expect(result.markdown).toContain("recall_decisions");
  });

  it("keeps pinned notes when the budget forces notes out", () => {
    const oldest = sampleNote({
      id: "pinned-oldest",
      date: "2024-01-01",
      title: "Supervisor add-on was removed deliberately",
      pin: true,
    });
    const filler = Array.from({ length: 40 }, (_, i) =>
      sampleNote({ id: `n${i}`, date: "2026-07-01", title: `Recent decision ${i}`, decision: "x".repeat(200) }),
    );

    const result = renderDecisionDigest([...filler, oldest]);

    expect(result.droppedNotes.length).toBeGreaterThan(0);
    expect(result.includedNotes[0]).toBe("pinned-oldest");
    expect(result.droppedNotes).not.toContain("pinned-oldest");
  });

  it("bounds the reference suffix so one note cannot crowd out the rest", () => {
    const noisy = sampleNote({
      id: "noisy",
      entities: Array.from({ length: 12 }, (_, i) => `sensor.a_very_long_entity_name_number_${i}`),
    });
    const line = renderDecisionDigest([noisy]).markdown.split("\n").find((l) => l.startsWith("- **"));
    expect(line).toContain("…");
    expect(byteLength(line)).toBeLessThan(400);
  });

  // Clamping the standard digest to fit would cut the truncation warning off the
  // end, leaving a fragment that reads as a complete list.
  it("degrades to a one-line warning rather than a truncated fragment", () => {
    const notes = Array.from({ length: 6 }, (_, i) =>
      sampleNote({ id: `n${i}`, date: `2026-07-0${i + 1}`, decision: "x".repeat(120) }),
    );
    const result = renderDecisionDigest(notes, { budgetBytes: 300 });

    expect(result.bytes).toBeLessThanOrEqual(300);
    expect(result.markdown).toContain("6 decision notes");
    expect(result.markdown).toContain("did not fit this context");
    expect(result.markdown).toContain("recall_decisions");
    expect(result.droppedNotes).toHaveLength(6);
    expect(result.includedNotes).toHaveLength(0);
  });

  it("emits nothing at all rather than a misleading stub", () => {
    const result = renderDecisionDigest([sampleNote()], { budgetBytes: 40 });
    expect(result.markdown).toBe("");
    expect(result.bytes).toBe(0);
  });

  it("stays within budget even when a single note is larger than it", () => {
    const huge = sampleNote({
      id: "huge",
      title: "T".repeat(LIMITS.title),
      decision: "d".repeat(LIMITS.decision),
      entities: Array.from({ length: LIMITS.maxRefs }, (_, i) => `sensor.${"x".repeat(100)}_${i}`),
    });
    const result = renderDecisionDigest([huge, sampleNote({ id: "second" })]);
    expect(byteLength(result.markdown)).toBeLessThanOrEqual(DECISION_DIGEST_BUDGET_BYTES);
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

// ---------------------------------------------------------------------------
// parse rejections are visible
// ---------------------------------------------------------------------------

describe("rejected entries", () => {
  it("counts entries the parser could not read", () => {
    const yaml = [
      "notes:",
      "  - id: good",
      "    date: 2026-07-01",
      "    title: Good",
      "    decision: Keep this.",
      "  - id: bad",
      "    date: 2026-07-02",
      "    title: Broken",
      "    status: retired",
    ].join("\n");

    const parsed = parseDecisionNotes(yaml);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
  });

  it("reports nothing rejected for a clean file", () => {
    expect(parseDecisionNotes(serializeDecisionNotes(stateWith(sampleNote()))).rejected).toBe(0);
  });
});
