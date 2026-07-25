/**
 * Decision notes — the durable "why" behind a Home Assistant configuration.
 *
 * Entity states and YAML can be re-read at any time; the reasoning cannot.
 * "That integration was removed on purpose", "this toggle is inverted to match
 * the vendor app", "leave the Node-RED automations alone" is exactly the
 * knowledge that is lost between sessions and expensive to rebuild.
 *
 * Two deliberate constraints shape this module:
 *
 *  - Notes are only ever recorded with the user's explicit approval, because an
 *    add-on whose first rule is "never change anything without asking" cannot
 *    quietly accumulate a file about someone's home.
 *  - What reaches the model's prompt is a capped digest of *active* notes, not
 *    the whole file. Superseding replaces consolidation, so the always-on cost
 *    stays bounded without asking a model to compact anything.
 *
 * Pure functions over parsed state — the caller owns all I/O.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { byteLength, describeSecretFindings, findSecrets } from "./context-budget.js";

/**
 * The notes themselves live in the configuration directory: they are the
 * user's record, they belong in Home Assistant backups, and they diff cleanly
 * for anyone keeping `/config` under version control.
 */
export const DECISION_NOTES_DIR = "/homeassistant/opencode";
export const DECISION_NOTES_PATH = `${DECISION_NOTES_DIR}/decisions.yaml`;

/** The injected digest is derived, so it lives with the other generated context. */
export const DECISION_DIGEST_PATH = "/data/context/decision-notes.md";

export const DECISION_NOTES_VERSION = 1;

/** ~500 tokens of always-on cost, matching the briefing's budget. */
export const DECISION_DIGEST_BUDGET_BYTES = 2048;

export const LIMITS = {
  /** Active notes are the ones that cost context on every request. */
  maxActive: 40,
  /** Superseded notes stay for the human; the file still needs an end. */
  maxTotal: 200,
  maxFileBytes: 64 * 1024,
  title: 100,
  decision: 320,
  rationale: 480,
  maxRefs: 12,
  refLength: 120,
};

const REF_FIELDS = ["entities", "files", "integrations"];

const FILE_HEADER = `# OpenCode decision notes
#
# Decisions and constraints about this Home Assistant installation, recorded by
# the OpenCode add-on only when you approve them. OpenCode reads a short digest
# of the active notes at the start of every session.
#
# Safe to edit or delete by hand. Keep the shape below; OpenCode refuses to add
# notes while the file cannot be parsed, so nothing is silently overwritten.
#
# Set a note's status to "superseded" (or delete it) to drop it from the digest.
`;

/** Collapse whitespace and strip control characters from user/model text. */
function cleanText(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRefs(values) {
  if (values === undefined || values === null) return [];
  const list = Array.isArray(values) ? values : [values];
  const cleaned = list
    .map((value) => cleanText(value).slice(0, LIMITS.refLength))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, LIMITS.maxRefs);
}

export function slugify(text, maxLength = 40) {
  const full = cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= maxLength) return full;

  // Cut back to a word boundary so ids stay readable ("...-inverted" rather
  // than "...-inverted-templ").
  const clipped = full.slice(0, maxLength);
  const lastSeparator = clipped.lastIndexOf("-");
  const trimmed = lastSeparator > maxLength / 2 ? clipped.slice(0, lastSeparator) : clipped;
  return trimmed.replace(/-+$/g, "");
}

function toDateString(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("decision-notes: invalid date");
  return date.toISOString().slice(0, 10);
}

/** Deterministic, human-readable, collision-free within the existing set. */
export function buildNoteId(title, dateString, existingIds = new Set()) {
  const base = `${dateString}-${slugify(title) || "note"}`;
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error("decision-notes: could not allocate a unique note id");
}

function normalizeNote(raw, index) {
  const errors = [];
  const where = `note ${index + 1}`;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { note: null, errors: [`${where}: expected a mapping with at least 'title' and 'decision'`] };
  }

  const title = cleanText(raw.title);
  const decision = cleanText(raw.decision);
  if (!title) errors.push(`${where}: 'title' is required`);
  if (!decision) errors.push(`${where}: 'decision' is required`);

  const status = raw.status === "superseded" ? "superseded" : "active";
  const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())
    ? raw.date.trim()
    : raw.date instanceof Date
      ? toDateString(raw.date)
      : null;
  if (!date) errors.push(`${where}: 'date' must be YYYY-MM-DD`);

  const id = cleanText(raw.id);
  if (!id) errors.push(`${where}: 'id' is required`);

  if (errors.length) return { note: null, errors };

  const note = {
    id,
    date,
    title: title.slice(0, LIMITS.title),
    decision: decision.slice(0, LIMITS.decision),
    status,
  };

  const rationale = cleanText(raw.rationale);
  if (rationale) note.rationale = rationale.slice(0, LIMITS.rationale);

  for (const field of REF_FIELDS) {
    const refs = cleanRefs(raw[field]);
    if (refs.length) note[field] = refs;
  }

  const supersededBy = cleanText(raw.superseded_by);
  if (supersededBy) note.superseded_by = supersededBy;

  return { note, errors: [] };
}

/**
 * Parse the notes file.
 *
 * Never throws: a hand-edited file that cannot be read is reported so the user
 * can be told exactly what is wrong, rather than having their file replaced.
 *
 * `ok: false` means writes must be refused — valid notes are still returned so
 * reading and the digest keep working.
 */
export function parseDecisionNotes(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return { ok: true, version: DECISION_NOTES_VERSION, notes: [], errors: [] };
  }

  let document;
  try {
    document = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      version: DECISION_NOTES_VERSION,
      notes: [],
      errors: [`decisions.yaml is not valid YAML: ${error.message}`],
    };
  }

  if (document === null || document === undefined) {
    return { ok: true, version: DECISION_NOTES_VERSION, notes: [], errors: [] };
  }

  if (typeof document !== "object" || Array.isArray(document)) {
    return {
      ok: false,
      version: DECISION_NOTES_VERSION,
      notes: [],
      errors: ["decisions.yaml must be a mapping with a 'notes' list"],
    };
  }

  const rawNotes = document.notes;
  if (rawNotes === undefined || rawNotes === null) {
    return { ok: true, version: document.version ?? DECISION_NOTES_VERSION, notes: [], errors: [] };
  }
  if (!Array.isArray(rawNotes)) {
    return {
      ok: false,
      version: document.version ?? DECISION_NOTES_VERSION,
      notes: [],
      errors: ["decisions.yaml: 'notes' must be a list"],
    };
  }

  const notes = [];
  const errors = [];
  const seenIds = new Set();

  rawNotes.forEach((raw, index) => {
    const { note, errors: noteErrors } = normalizeNote(raw, index);
    if (!note) {
      errors.push(...noteErrors);
      return;
    }
    if (seenIds.has(note.id)) {
      errors.push(`note ${index + 1}: duplicate id '${note.id}'`);
      return;
    }
    seenIds.add(note.id);
    notes.push(note);
  });

  return {
    ok: errors.length === 0,
    version: document.version ?? DECISION_NOTES_VERSION,
    notes,
    errors,
  };
}

/** Serialize state back to the on-disk format, header comment included. */
export function serializeDecisionNotes(state) {
  const payload = {
    version: state?.version ?? DECISION_NOTES_VERSION,
    notes: (state?.notes ?? []).map((note) => {
      const ordered = {
        id: note.id,
        date: note.date,
        title: note.title,
        decision: note.decision,
      };
      if (note.rationale) ordered.rationale = note.rationale;
      for (const field of REF_FIELDS) {
        if (note[field]?.length) ordered[field] = note[field];
      }
      ordered.status = note.status;
      if (note.superseded_by) ordered.superseded_by = note.superseded_by;
      return ordered;
    }),
  };

  return `${FILE_HEADER}\n${stringifyYaml(payload, { lineWidth: 90, indent: 2 })}`;
}

export function activeNotes(notes = []) {
  return notes.filter((note) => note.status !== "superseded");
}

/**
 * Add a note to the parsed state.
 *
 * Returns an `error` instead of throwing so the MCP layer can turn every
 * refusal into an explanation the model can act on.
 *
 * @param {{version: number, notes: object[]}} state
 * @param {object} input
 * @param {{now: Date|string, secretValues?: string[]}} context
 */
export function addNote(state, input, context) {
  const notes = [...(state?.notes ?? [])];
  const version = state?.version ?? DECISION_NOTES_VERSION;
  const dateString = toDateString(context?.now ?? new Date());

  const title = cleanText(input?.title);
  const decision = cleanText(input?.decision);
  const rationale = cleanText(input?.rationale);

  if (!title) return { error: "A note needs a short 'title'." };
  if (!decision) return { error: "A note needs a 'decision' describing what was decided." };

  if (title.length > LIMITS.title) {
    return { error: `'title' is limited to ${LIMITS.title} characters — shorten it to the essential claim.` };
  }
  if (decision.length > LIMITS.decision) {
    return {
      error:
        `'decision' is limited to ${LIMITS.decision} characters because it is injected into every session. ` +
        "Keep the decision itself here and move the detail into 'rationale'.",
    };
  }
  if (rationale.length > LIMITS.rationale) {
    return { error: `'rationale' is limited to ${LIMITS.rationale} characters.` };
  }

  const secretScanTarget = [title, decision, rationale, ...REF_FIELDS.flatMap((field) => cleanRefs(input?.[field]))].join("\n");
  const findings = findSecrets(secretScanTarget, context?.secretValues ?? []);
  if (findings.length) {
    return {
      error:
        `This note contains ${describeSecretFindings(findings)}. Decision notes are sent to the model with every ` +
        "session and are stored in the Home Assistant configuration directory, so credentials must not go in them. " +
        "Reference the secret by name instead (for example `!secret my_token`).",
    };
  }

  const supersedes = cleanRefs(input?.supersedes);
  const knownIds = new Set(notes.map((note) => note.id));
  const unknown = supersedes.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    return { error: `Cannot supersede unknown note id(s): ${unknown.join(", ")}.` };
  }

  const normalizedTitle = title.toLowerCase();
  const duplicate = activeNotes(notes).find(
    (note) => note.title.toLowerCase() === normalizedTitle && !supersedes.includes(note.id),
  );
  if (duplicate) {
    return {
      error:
        `An active note with this title already exists (id '${duplicate.id}'). Either refine that note by passing ` +
        `supersedes: ["${duplicate.id}"], or give this one a distinct title.`,
    };
  }

  const superseding = new Set(supersedes);
  const updated = notes.map((note) =>
    superseding.has(note.id) ? { ...note, status: "superseded" } : note,
  );

  const id = buildNoteId(title, dateString, knownIds);
  const note = { id, date: dateString, title, decision, status: "active" };
  if (rationale) note.rationale = rationale;
  for (const field of REF_FIELDS) {
    const refs = cleanRefs(input?.[field]);
    if (refs.length) note[field] = refs;
  }
  for (const supersededId of superseding) {
    const target = updated.find((candidate) => candidate.id === supersededId);
    if (target) target.superseded_by = id;
  }

  const nextNotes = [...updated, note];

  const activeCount = activeNotes(nextNotes).length;
  if (activeCount > LIMITS.maxActive) {
    return {
      error:
        `This installation already has ${LIMITS.maxActive} active decision notes, which is the limit that keeps the ` +
        "session digest small. Supersede a note that no longer applies (pass its id in 'supersedes'), or ask the user " +
        "which one to retire, before recording a new one.",
    };
  }
  if (nextNotes.length > LIMITS.maxTotal) {
    return {
      error:
        `decisions.yaml has reached ${LIMITS.maxTotal} notes including superseded ones. Ask the user to prune old ` +
        "superseded entries from the file before recording more.",
    };
  }

  const nextState = { version, notes: nextNotes };
  const serialized = serializeDecisionNotes(nextState);
  if (byteLength(serialized) > LIMITS.maxFileBytes) {
    return { error: "decisions.yaml would exceed its size limit. Prune superseded notes before recording more." };
  }

  return { state: nextState, note, serialized };
}

/** Mark notes superseded without deleting them. */
export function supersedeNotes(state, ids, options = {}) {
  const notes = [...(state?.notes ?? [])];
  const targets = cleanRefs(ids);
  if (!targets.length) return { error: "Pass at least one note id to supersede." };

  const known = new Map(notes.map((note) => [note.id, note]));
  const unknown = targets.filter((id) => !known.has(id));
  if (unknown.length) return { error: `Unknown note id(s): ${unknown.join(", ")}.` };

  const alreadyInactive = targets.filter((id) => known.get(id).status === "superseded");
  if (alreadyInactive.length === targets.length) {
    return { error: `Note(s) already superseded: ${alreadyInactive.join(", ")}.` };
  }

  const supersededBy = cleanText(options.supersededBy);
  const nextNotes = notes.map((note) => {
    if (!targets.includes(note.id)) return note;
    const updated = { ...note, status: "superseded" };
    if (supersededBy) updated.superseded_by = supersededBy;
    return updated;
  });

  const nextState = { version: state?.version ?? DECISION_NOTES_VERSION, notes: nextNotes };
  return { state: nextState, serialized: serializeDecisionNotes(nextState), superseded: targets };
}

/** Substring search across the fields a user would actually recall. */
export function searchNotes(notes = [], options = {}) {
  const query = cleanText(options.query).toLowerCase();
  const includeSuperseded = Boolean(options.includeSuperseded);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

  const pool = includeSuperseded ? notes : activeNotes(notes);
  const matched = query
    ? pool.filter((note) => {
        const haystack = [
          note.id,
          note.title,
          note.decision,
          note.rationale,
          ...REF_FIELDS.flatMap((field) => note[field] ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : pool;

  return [...matched]
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)))
    .slice(0, limit);
}

function renderNoteLine(note) {
  const refs = REF_FIELDS.flatMap((field) => note[field] ?? []);
  const suffix = refs.length ? ` _(${refs.slice(0, 6).join(", ")})_` : "";
  return `- **${note.date} — ${note.title}** — ${note.decision}${suffix}`;
}

/**
 * Render the digest that is injected into the session prompt.
 *
 * Active notes only, newest first, title and decision only. Rationale and
 * superseded history stay in the file and are reachable through
 * `recall_decisions` when they are actually needed.
 */
export function renderDecisionDigest(notes = [], options = {}) {
  const budgetBytes = options.budgetBytes ?? DECISION_DIGEST_BUDGET_BYTES;
  const active = [...activeNotes(notes)].sort((a, b) =>
    a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date),
  );

  if (!active.length) return { markdown: "", bytes: 0, includedNotes: [], droppedNotes: [] };

  const header = [
    "# Decision notes for this Home Assistant installation",
    "",
    "Standing decisions and constraints the user has confirmed. They remain in force unless the",
    "user changes them: if a request would undo one, say so before acting rather than silently",
    "reversing it. Use `recall_decisions` for the full reasoning or superseded history, and offer",
    "`remember_decision` — after the user agrees — when a new lasting decision is made.",
  ].join("\n");

  // Notes are consecutive list items rather than independent sections, so they
  // are fitted directly instead of through `assembleSections`.
  const lines = [header, ""];
  const includedNotes = [];
  const droppedNotes = [];
  let used = byteLength(`${header}\n\n`);

  for (const note of active) {
    const line = renderNoteLine(note);
    const cost = byteLength(`${line}\n`);
    if (used + cost > budgetBytes) {
      droppedNotes.push(note.id);
      continue;
    }
    lines.push(line);
    includedNotes.push(note.id);
    used += cost;
  }

  if (droppedNotes.length) {
    const notice = `\n_${droppedNotes.length} older note(s) omitted to stay within the context budget — use \`recall_decisions\` to read them._`;
    if (used + byteLength(notice) <= budgetBytes) lines.push(notice);
  }

  const markdown = `${lines.join("\n")}\n`;

  return { markdown, bytes: byteLength(markdown), includedNotes, droppedNotes };
}
