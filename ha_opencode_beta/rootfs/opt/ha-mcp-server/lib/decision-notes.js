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
import { byteLength, describeSecretFindings, findSecrets, plausibleSecretValues } from "./context-budget.js";

/**
 * The notes themselves live in the configuration directory: they are the
 * user's record, they belong in Home Assistant backups, and they diff cleanly
 * for anyone keeping `/config` under version control.
 *
 * Per channel, though. That directory is mounted by BOTH the stable and the
 * beta add-on, so a note recorded while trying something out in beta would
 * otherwise be injected into every stable session for good. ADDON_CHANNEL is
 * set from a Docker build arg — see rootfs/usr/local/lib/opencode/channel.sh.
 */
export const DECISION_NOTES_DIR =
  process.env.ADDON_CHANNEL === "beta" ? "/homeassistant/opencode_beta" : "/homeassistant/opencode";
export const DECISION_NOTES_PATH = `${DECISION_NOTES_DIR}/decisions.yaml`;

/**
 * The same file, named the way the user sees it. Home Assistant calls the
 * configuration directory `/config`; the add-on mounts it at `/homeassistant`.
 * Messages that tell someone to go and edit the file must use their name for
 * it, not ours.
 */
export const DECISION_NOTES_DISPLAY_PATH = DECISION_NOTES_PATH.replace("/homeassistant/", "/config/");

/** The injected digest is derived, so it lives with the other generated context. */
export const DECISION_DIGEST_PATH = "/data/context/decision-notes.md";

export const DECISION_NOTES_VERSION = 1;

/** ~500 tokens of always-on cost, matching the briefing's budget. */
export const DECISION_DIGEST_BUDGET_BYTES = 2048;

export const LIMITS = {
  /**
   * Storage cap on active notes.
   *
   * This is not the context cap: how many notes reach the model is decided by
   * the digest's byte budget, which typically fits far fewer than this. Keeping
   * storage generous is deliberate — a note that no longer fits the digest is
   * still true, still the user's record, and still reachable through
   * `recall_decisions`. Anything that reports this number must say which of the
   * two limits it means.
   */
  maxActive: 40,
  /**
   * Pinned notes lead the digest, so they are the notes that survive when the
   * budget runs out. Capped because pinning everything pins nothing.
   */
  maxPinned: 10,
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
# Add "pin: true" to a note to keep it in the digest when older notes no longer
# fit — use it for the decisions that must never be reversed by accident.
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

/**
 * Clean a list of note ids.
 *
 * Deliberately not `cleanRefs`: capping a *reference* list is cosmetic, but
 * capping an *id* list changes what happens. Silently keeping the first twelve
 * of fifteen ids to supersede would leave three retired constraints active while
 * reporting success — the caller is told instead.
 */
function cleanIdList(values) {
  if (values === undefined || values === null) return [];
  const list = Array.isArray(values) ? values : [values];
  // Each id is still clamped — dropping the *count* cap is the fix; dropping the
  // length clamp too would let a caller's junk id be echoed back at any size.
  const cleaned = list.map((value) => cleanText(value).slice(0, LIMITS.refLength)).filter(Boolean);
  return [...new Set(cleaned)];
}

/** Name the offenders without letting a long list become the whole response. */
function describeIds(ids, max = 10) {
  const shown = ids.slice(0, max).map((id) => `'${id}'`).join(", ");
  return ids.length > max ? `${shown}, and ${ids.length - max} more` : shown;
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

/**
 * The local calendar date.
 *
 * Not `toISOString()`: the add-on runs in the Home Assistant time zone, and a
 * note recorded at 00:30 in Oslo or 19:00 in Chicago would otherwise be stamped
 * with the wrong day — in the second case a day in the future, which then sorts
 * to the top of the digest and stays there.
 */
function toDateString(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("decision-notes: invalid date");
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

/** Keys this module understands; anything else belongs to the user and is kept. */
const KNOWN_NOTE_KEYS = new Set([
  "id",
  "date",
  "title",
  "decision",
  "rationale",
  "status",
  "pin",
  "superseded_by",
  ...REF_FIELDS,
]);

/** Carries the user's own keys through a rewrite without exposing them as note fields. */
const EXTRA_KEYS = Symbol("decision-notes.extraKeys");

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

  // An unrecognized status is an error, never a fallback to "active". Reading
  // `status: retired` as active would put a decision the user retired back into
  // every session's prompt — a silent reversal, which is the one thing this
  // feature exists to prevent.
  const rawStatus = raw.status === undefined || raw.status === null ? "active" : cleanText(raw.status);
  if (rawStatus !== "active" && rawStatus !== "superseded") {
    errors.push(`${where}: 'status' must be 'active' or 'superseded' (found '${rawStatus}')`);
  }

  const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())
    ? raw.date.trim()
    : raw.date instanceof Date
      ? toDateString(raw.date)
      : null;
  if (!date) errors.push(`${where}: 'date' must be YYYY-MM-DD`);

  const id = cleanText(raw.id);
  if (!id) errors.push(`${where}: 'id' is required`);

  if (errors.length) return { note: null, errors };

  // Hand-written text is preserved exactly as written. Truncating it here would
  // write the shortened version back to the user's file on the next save; the
  // length limits belong on what the model submits, and the digest bounds what
  // is injected by bytes anyway.
  const note = { id, date, title, decision, status: rawStatus };

  // Hand-editable, so accept the YAML spellings of "true" a person would write.
  if (raw.pin === true || raw.pin === "true" || raw.pin === "yes") note.pin = true;

  const rationale = cleanText(raw.rationale);
  if (rationale) note.rationale = rationale;

  for (const field of REF_FIELDS) {
    const refs = cleanRefs(raw[field]);
    if (refs.length) note[field] = refs;
  }

  const supersededBy = cleanText(raw.superseded_by);
  if (supersededBy) note.superseded_by = supersededBy;

  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_NOTE_KEYS.has(key)) extra[key] = value;
  }
  if (Object.keys(extra).length) {
    Object.defineProperty(note, EXTRA_KEYS, { value: extra, enumerable: false });
  }

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
/**
 * A YAML error message with the offending source left out.
 *
 * Parser messages quote the line that failed, and this error is reported to the
 * model. A file broken *because* someone pasted a token into it would otherwise
 * have that token read out in the failure message — the file is unreadable, so
 * the screen that normally catches this cannot run.
 */
function describeYamlError(error) {
  const message = String(error?.message ?? error ?? "unknown error");
  // Keep the parser's summary and its line/column, drop any quoted source.
  const firstLine = message.split("\n")[0].trim().replace(/\s*:\s*$/, "");
  const position = error?.linePos?.[0];
  const where = position?.line && !/\bline \d+/.test(firstLine)
    ? ` (line ${position.line}, column ${position.col ?? 1})`
    : "";
  return `${firstLine}${where}`;
}

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
      errors: [`decisions.yaml is not valid YAML: ${describeYamlError(error)}`],
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
  let rejected = 0;

  rawNotes.forEach((raw, index) => {
    const { note, errors: noteErrors } = normalizeNote(raw, index);
    if (!note) {
      errors.push(...noteErrors);
      rejected += 1;
      return;
    }
    if (seenIds.has(note.id)) {
      errors.push(`note ${index + 1}: duplicate id '${note.id}'`);
      rejected += 1;
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
    // How many entries exist in the file but are not in `notes`. Callers that
    // render context need this: a digest built from the readable subset must not
    // present itself as the complete record.
    rejected,
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
      if (note.pin) ordered.pin = true;
      ordered.status = note.status;
      if (note.superseded_by) ordered.superseded_by = note.superseded_by;
      // Keys this module does not use are the user's, and survive the rewrite.
      Object.assign(ordered, note[EXTRA_KEYS] ?? {});
      return ordered;
    }),
  };

  return `${FILE_HEADER}\n${stringifyYaml(payload, { lineWidth: 90, indent: 2 })}`;
}

export function activeNotes(notes = []) {
  return notes.filter((note) => note.status !== "superseded");
}

/**
 * Split notes into the ones safe to send to a model and the ones that are not.
 *
 * `addNote` screens what it writes, but the file is the user's and is documented
 * as hand-editable — someone pasting an older memory file into it, or writing a
 * token into a note by hand, must not be able to put a credential into the
 * system prompt of every future session. Screening therefore belongs at the
 * point the text is handed to the model, not only at the point it is written.
 *
 * The whole note is screened, rationale included, because `recall_decisions`
 * returns fields the digest leaves out.
 *
 * @returns {{safe: object[], withheld: string[]}} withheld carries ids only —
 *   never the offending text, which must not be echoed anywhere.
 */
export function screenNotesForSecrets(notes = [], secretValues = []) {
  const safe = [];
  const withheld = [];
  // Only credential-shaped values are matched here; see `plausibleSecretValues`
  // for why the read path is narrower than the write path.
  const values = plausibleSecretValues(secretValues);

  for (const note of notes ?? []) {
    const target = [
      note.title,
      note.decision,
      note.rationale,
      ...REF_FIELDS.flatMap((field) => note[field] ?? []),
    ]
      .filter(Boolean)
      .join("\n");

    if (findSecrets(target, values).length) withheld.push(note.id);
    else safe.push(note);
  }

  return { safe, withheld };
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

  const supersedes = cleanIdList(input?.supersedes);
  const knownIds = new Set(notes.map((note) => note.id));
  const unknown = supersedes.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    return { error: `Cannot supersede unknown note id(s): ${describeIds(unknown)}.` };
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
  if (input?.pin === true) note.pin = true;
  for (const field of REF_FIELDS) {
    const refs = cleanRefs(input?.[field]);
    if (refs.length) note[field] = refs;
  }

  if (note.pin) {
    // `updated` already carries the supersedes from this call, so a note that
    // replaces a pinned one inherits its place rather than competing with it.
    const pinnedCount = activeNotes(updated).filter((existing) => existing.pin).length;
    if (pinnedCount >= LIMITS.maxPinned) {
      return {
        error:
          `This installation already has ${LIMITS.maxPinned} pinned notes, which is the most that can be kept at the ` +
          "front of the session digest. Record this one without a pin, or ask the user which pinned note should give " +
          "up its place first.",
      };
    }
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
        `This installation is at its limit of ${LIMITS.maxActive} stored active decision notes. Supersede a note that ` +
        "no longer applies (pass its id in 'supersedes'), or ask the user which one to retire, before recording a " +
        "new one.",
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
  const targets = cleanIdList(ids);
  if (!targets.length) return { error: "Pass at least one note id to supersede." };

  const known = new Map(notes.map((note) => [note.id, note]));
  const unknown = targets.filter((id) => !known.has(id));
  if (unknown.length) return { error: `Unknown note id(s): ${describeIds(unknown)}.` };

  const alreadyInactive = targets.filter((id) => known.get(id).status === "superseded");
  if (alreadyInactive.length === targets.length) {
    return { error: `Note(s) already superseded: ${describeIds(alreadyInactive)}.` };
  }

  const supersededBy = cleanText(options.supersededBy);
  const retiring = new Set(targets.filter((id) => known.get(id).status !== "superseded"));
  const nextNotes = notes.map((note) => {
    if (!retiring.has(note.id)) return note;
    const updated = { ...note, status: "superseded" };
    // Never overwrite an existing link: that chain is the record of what
    // replaced what, and a second pass would erase it.
    if (supersededBy && !updated.superseded_by) updated.superseded_by = supersededBy;
    return updated;
  });

  const nextState = { version: state?.version ?? DECISION_NOTES_VERSION, notes: nextNotes };
  return {
    state: nextState,
    serialized: serializeDecisionNotes(nextState),
    superseded: [...retiring],
    alreadySuperseded: alreadyInactive,
  };
}

/**
 * Words carrying no signal in a query like "why is the camera toggle inverted".
 *
 * Dropping them is what lets a question be used as a query at all — the model
 * asks in sentences, and a whole-phrase match against a sentence never hits.
 */
const SEARCH_STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "because", "been", "but", "by", "can", "did", "do",
  "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my", "not", "of",
  "on", "or", "our", "should", "so", "than", "that", "the", "their", "then", "there", "these", "this", "those",
  "to", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "would", "you",
  "your",
]);

/** Split a query into searchable terms, keeping entity ids (`light.hall`) whole. */
export function searchTerms(query) {
  return [
    ...new Set(
      cleanText(query)
        .toLowerCase()
        .split(/[^a-z0-9._:-]+/)
        .map((term) => term.replace(/^[._:-]+|[._:-]+$/g, ""))
        .filter((term) => term.length > 1 && !SEARCH_STOPWORDS.has(term)),
    ),
  ];
}

/**
 * Fields worth matching, and how much a hit in each one counts.
 *
 * A term in the title is a much stronger signal than the same term buried in a
 * rationale, and ranking on that is what keeps a loose query useful.
 */
const SEARCH_FIELDS = [
  { weight: 4, get: (note) => note.title },
  { weight: 3, get: (note) => note.decision },
  { weight: 3, get: (note) => REF_FIELDS.flatMap((field) => note[field] ?? []).join(" ") },
  { weight: 2, get: (note) => note.rationale },
  { weight: 1, get: (note) => note.id },
];

/** Crude singular/plural tolerance — no stemmer, no dependency, catches the common miss. */
function termVariants(term) {
  if (term.length > 3 && term.endsWith("s")) return [term, term.slice(0, -1)];
  if (term.length > 2) return [term, `${term}s`];
  return [term];
}

/**
 * Whether a field contains a term as a word rather than as any substring.
 *
 * Plain `includes` lets "ha" hit "hallway" and "cam" hit "camera", which is how
 * an unrelated note outranks the one the user meant. Matching at a word edge
 * keeps entity ids (`switch.tc71_cam_1`) working, since `.` and `_` are edges.
 */
function fieldMatches(text, variants) {
  return variants.some((variant) => {
    let from = 0;
    for (;;) {
      const at = text.indexOf(variant, from);
      if (at === -1) return false;
      const before = at === 0 ? "" : text[at - 1];
      const after = text[at + variant.length] ?? "";
      const isEdge = (char) => char === "" || !/[a-z0-9]/.test(char);
      if (isEdge(before) && isEdge(after)) return true;
      from = at + 1;
    }
  });
}

function scoreNote(note, terms, phrase) {
  const fields = SEARCH_FIELDS.map(({ weight, get }) => ({ weight, text: String(get(note) ?? "").toLowerCase() }));
  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    const variants = termVariants(term);
    let best = 0;
    for (const { weight, text } of fields) {
      if (fieldMatches(text, variants)) best = Math.max(best, weight);
    }
    if (best) {
      score += best;
      matchedTerms += 1;
    }
  }

  if (!matchedTerms) return 0;

  // Every term present beats a partial hit, and an exact phrase beats both.
  if (matchedTerms === terms.length && terms.length > 1) score += 4;
  if (phrase && fields.some(({ text }) => text.includes(phrase))) score += 8;

  return score;
}

/**
 * Search the fields a user would actually recall.
 *
 * Term-scored rather than a single substring match: `recall_decisions` is what
 * makes the small always-on digest safe, so a query that fails to find a note
 * that exists is not a search miss — it tells the model that no such decision
 * was ever made, which is the one wrong answer this feature cannot give.
 */
export function searchNotes(notes = [], options = {}) {
  return searchNoteMatches(notes, options).matches;
}

/**
 * Search, reporting how many notes matched as well as which were returned.
 *
 * The count matters: a caller that prints `matches.length` after a `limit` has
 * been applied tells the model "3 notes exist" when there are thirty, and an
 * undercount here reads the same way as an absence.
 *
 * @returns {{matches: object[], totalMatched: number, truncated: boolean}}
 */
export function searchNoteMatches(notes = [], options = {}) {
  const phrase = cleanText(options.query).toLowerCase();
  const terms = searchTerms(options.query);
  const includeSuperseded = Boolean(options.includeSuperseded);
  // Anything that is not a usable positive number falls back to the documented
  // default. Coercing `null`/`0`/`""` to 1 would return a single note and read
  // as "that is all there is".
  const requested = Math.trunc(Number(options.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 100) : 20;

  const pool = includeSuperseded ? notes : activeNotes(notes);
  const byDate = (a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date));

  const ranked = !terms.length
    ? // No usable terms (empty query, or one made only of stopwords) lists
      // everything rather than nothing — an empty result would read as
      // "no decisions exist".
      [...pool].sort(byDate)
    : pool
        .map((note) => ({ note, score: scoreNote(note, terms, phrase) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || byDate(a.note, b.note))
        .map((entry) => entry.note);

  return {
    matches: ranked.slice(0, limit),
    totalMatched: ranked.length,
    truncated: ranked.length > limit,
  };
}

/**
 * Order notes for the digest.
 *
 * Pinned first, then newest first. Without pinning the budget evicts by age,
 * which is backwards: the oldest standing constraints are usually the ones most
 * likely to be reversed by accident precisely because everyone has forgotten
 * them. Pinning is how a user says "this one always travels".
 */
function digestOrder(notes) {
  return [...notes].sort((a, b) => {
    if (Boolean(a.pin) !== Boolean(b.pin)) return a.pin ? -1 : 1;
    return a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date);
  });
}

/** Longest the reference suffix on one digest line may grow. */
const DIGEST_REFS_BUDGET = 96;

function renderNoteLine(note) {
  const refs = REF_FIELDS.flatMap((field) => note[field] ?? []);

  // Bounded per line: twelve long entity ids on one note would otherwise crowd
  // every other note out of the digest.
  const shown = [];
  let used = 0;
  for (const ref of refs) {
    // Bytes, not characters: the budget this feeds is a byte budget, and a
    // non-ASCII entity name costs more than its length suggests.
    const cost = byteLength(ref) + (shown.length ? 2 : 0);
    if (used + cost > DIGEST_REFS_BUDGET) break;
    shown.push(ref);
    used += cost;
  }

  // A single very long reference fits nothing; say the references exist rather
  // than rendering a line that looks like a note with none.
  let suffix = "";
  if (shown.length) {
    suffix = ` _(${shown.join(", ")}${shown.length < refs.length ? ", …" : ""})_`;
  } else if (refs.length) {
    suffix = ` _(${refs.length} reference${refs.length === 1 ? "" : "s"}, see \`recall_decisions\`)_`;
  }

  return `- **${note.date} — ${note.title}** — ${note.decision}${suffix}`;
}

const DIGEST_INTRO = [
  "# Decision notes for this Home Assistant installation",
  "",
  "Standing decisions and constraints the user has confirmed. They remain in force unless the",
  "user changes them: if a request would undo one, say so before acting rather than silently",
  "reversing it. Use `recall_decisions` for the full reasoning or superseded history, and offer",
  "`remember_decision` — after the user agrees — when a new lasting decision is made.",
].join("\n");

/**
 * State the scope of the list explicitly, in both directions.
 *
 * A model cannot tell a complete list from a truncated one by looking at it, and
 * the failure that matters here is silent: a decision that was dropped for space
 * reads exactly like a decision that was never made, which is how a deliberate
 * configuration gets "fixed". So the digest always says which case it is in.
 *
 * The completeness claim is bounded to the rebuild it was written at. This file
 * is regenerated at add-on start and on `ha-context refresh`, not when a note is
 * recorded — recording writes decisions.yaml alone, so that adding a note cannot
 * rewrite a prompt OpenCode re-reads on every request. An unbounded "nothing has
 * been left out" would therefore be a claim this function cannot make good on.
 * The truncated branch needs no such caveat: it already sends the model to
 * `recall_decisions`, which reads the notes file itself.
 */
function completeScope(total, everythingReadable) {
  // "Nothing has been left out" is only true when nothing was withheld for
  // credentials and nothing was unreadable. Claiming it otherwise is the same
  // failure as silent truncation, one level up.
  const claim = everythingReadable
    ? " — nothing had been left out when this summary was built. Notes recorded since are in " +
      "force but are not listed here; `recall_decisions` reads the file itself"
    : "";
  return total === 1
    ? `This is the only active note that reached this summary${claim}.`
    : `All ${total} active notes that reached this summary are listed here${claim}.`;
}

function unreadableScope(unreadable) {
  const one = unreadable === 1;
  return (
    `${one ? "One entry" : `${unreadable} entries`} in \`${DECISION_NOTES_DISPLAY_PATH}\` could not be read and ` +
    `${one ? "is" : "are"} missing from this summary. Tell the user, and use \`recall_decisions\` rather than ` +
    "assuming the decisions below are all of them."
  );
}

function partialScope(shown, total, omitted) {
  return (
    `Listing ${shown} of ${total} active notes — ${omitted} did not fit here and are NOT shown below. ` +
    "The omitted notes are still in force. Never conclude from this list that no decision exists: call " +
    "`recall_decisions` before changing anything that looks deliberate or unusual."
  );
}

/**
 * The least that is still true, for a budget too small for the real digest.
 *
 * Clamping the full digest to fit would cut the truncation warning off the end
 * and leave a fragment that looks like a complete list — the exact failure the
 * warning exists to prevent. Better to say only this.
 */
function minimalScope(total) {
  return (
    `# Decision notes\n\n${total} decision note${total === 1 ? "" : "s"} recorded for this installation did not ` +
    "fit this context. They are still in force — call `recall_decisions` before changing anything that looks " +
    "deliberate.\n"
  );
}

function withheldScope(withheld) {
  const one = withheld === 1;
  return (
    `${one ? "One note is" : `${withheld} notes are`} withheld from this context because ` +
    `${one ? "it contains" : "they contain"} credential-shaped text. Tell the user to edit or remove ` +
    `${one ? "it" : "them"} in \`${DECISION_NOTES_DISPLAY_PATH}\` — a note is sent to the model every session, ` +
    "so it must not carry a password, token, or anything from `secrets.yaml`."
  );
}

/**
 * Fit note lines into whatever the header leaves.
 *
 * @param {object[]} active ordered notes
 * @param {number} available bytes left for the list itself
 */
function packNoteLines(active, available) {
  const lines = [];
  const includedNotes = [];
  const droppedNotes = [];
  let used = 0;

  for (const note of active) {
    const line = renderNoteLine(note);
    const cost = byteLength(line) + (lines.length ? 1 : 0);
    if (used + cost > available) {
      droppedNotes.push(note.id);
      continue;
    }
    lines.push(line);
    includedNotes.push(note.id);
    used += cost;
  }

  return { lines, includedNotes, droppedNotes };
}

/**
 * Render the digest that is injected into the session prompt.
 *
 * Active notes only, pinned first then newest first, title and decision only.
 * Rationale and superseded history stay in the file and are reachable through
 * `recall_decisions` when they are actually needed.
 *
 * Fitted in two passes: once assuming everything fits, and again with room set
 * aside for the truncation warning if it turns out not to. The warning is
 * therefore guaranteed space rather than fitted last and lost when the budget is
 * already spent — which is what made truncation silent before.
 */
export function renderDecisionDigest(notes = [], options = {}) {
  const budgetBytes = options.budgetBytes ?? DECISION_DIGEST_BUDGET_BYTES;
  const unreadable = Math.max(0, Number(options.unreadable) || 0);
  const screened = screenNotesForSecrets(activeNotes(notes), options.secretValues ?? []);
  const active = digestOrder(screened.safe);
  const withheldNotes = screened.withheld;

  // Every reason a note is not in the list below gets its own sentence, and the
  // completeness claim is only made when none of them apply.
  const caveats = [
    withheldNotes.length ? withheldScope(withheldNotes.length) : "",
    unreadable ? unreadableScope(unreadable) : "",
  ].filter(Boolean);
  const withheldSuffix = caveats.length ? `\n\n${caveats.join("\n\n")}` : "";
  const everythingReadable = !withheldNotes.length && !unreadable;

  if (!active.length) {
    // Everything withheld or unreadable is still worth saying: silence would
    // leave the user believing their notes are in play when none of them are.
    if (!caveats.length) {
      return { markdown: "", bytes: 0, includedNotes: [], droppedNotes: [], withheldNotes: [], totalActive: 0 };
    }
    const document = `${DIGEST_INTRO}\n\n${caveats.join("\n\n")}\n`;
    const markdown = byteLength(document) <= budgetBytes ? document : "";
    return {
      markdown,
      bytes: byteLength(markdown),
      includedNotes: [],
      droppedNotes: [],
      withheldNotes,
      totalActive: 0,
    };
  }

  const total = active.length;
  const overheadFor = (scope) => byteLength(`${DIGEST_INTRO}\n\n${scope}\n\n`) + 1; // + trailing newline

  let scope = `${completeScope(total, everythingReadable)}${withheldSuffix}`;
  let packed = packNoteLines(active, budgetBytes - overheadFor(scope));

  if (packed.droppedNotes.length) {
    // Reserve against the widest the warning could get: every count at its
    // maximum, so the line we actually render can only be shorter.
    const reserve = overheadFor(`${partialScope(total, total, total)}${withheldSuffix}`);
    packed = packNoteLines(active, budgetBytes - reserve);
    scope = `${partialScope(packed.includedNotes.length, total, packed.droppedNotes.length)}${withheldSuffix}`;
  }

  const document = `${DIGEST_INTRO}\n\n${scope}\n\n${packed.lines.join("\n")}\n`;

  if (byteLength(document) <= budgetBytes) {
    return {
      markdown: document,
      bytes: byteLength(document),
      includedNotes: packed.includedNotes,
      droppedNotes: packed.droppedNotes,
      withheldNotes,
      totalActive: total,
    };
  }

  // Too small for the standard shape. Degrade to the one-line version, and to
  // nothing at all if even that will not fit — an empty digest is honest, a
  // truncated one is not.
  return fallbackDigest(total, active, withheldNotes, budgetBytes);
}

function fallbackDigest(total, active, withheldNotes, budgetBytes) {
  const allDropped = active.map((note) => note.id);
  const minimal = minimalScope(total);

  const markdown = byteLength(minimal) <= budgetBytes ? minimal : "";
  return {
    markdown,
    bytes: byteLength(markdown),
    includedNotes: [],
    droppedNotes: allDropped,
    withheldNotes,
    totalActive: total,
  };
}
