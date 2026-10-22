import { createHash } from "node:crypto";
import { activeNotes, screenNotesForSecrets, searchNoteMatches } from "./decision-notes.js";

export const DECISION_RECALL_BUDGET_BYTES = 8 * 1024;
const BODY_BUDGET = DECISION_RECALL_BUDGET_BYTES - 1536;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function formatDecisionNote(note) {
  const lines = [`### ${note.title}`, `- id: \`${note.id}\``, `- date: ${note.date}`,
    `- status: ${note.status}${note.pin && note.status === "active" ? " (pinned priority; inclusion is not guaranteed)" : ""}`,
    `- decision: ${note.decision}`];
  if (note.rationale) lines.push(`- rationale: ${note.rationale}`);
  for (const field of ["entities", "files", "integrations"]) {
    if (note[field]?.length) lines.push(`- ${field}: ${note[field].join(", ")}`);
  }
  if (note.superseded_by) lines.push(`- superseded by: \`${note.superseded_by}\``);
  return lines.join("\n");
}

function invalid(message) { return { text: `# Decision recall\n\n${message}`, isError: true }; }

/** All rendered text, including warnings and the cursor, shares the 8 KiB bound. */
export function recallDecisionPage(state, args = {}, secretValues = []) {
  if (!state.ok && !state.notes.length) {
    return invalid("The decision-notes record could not be read safely or uses an unsupported format. It was not changed. Review it locally or restore a backup; do not assume that no decisions exist.");
  }
  if (!state.exists) return { text: "No decision notes have been recorded for this installation yet. Offer remember_decision only after approval." };

  const options = { includeSuperseded: args.include_superseded === true, limit: args.limit ?? 20 };
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) return invalid("limit must be an integer from 1 to 100.");
  for (const key of ["id", "query", "entity", "file", "integration"]) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "string" || args[key].length > 512) return invalid("Recall filters must be strings of at most 512 characters.");
    options[key] = args[key].trim();
  }
  if (options.id && ["query", "entity", "file", "integration"].some((key) => options[key])) return invalid("Use id alone for exact lookup, or use query/reference filters for search.");

  const screened = screenNotesForSecrets(state.notes, secretValues);
  const revision = hash(`${state.revision}\0${screened.safe.map((note) => note.id).join("\0")}`);
  const fingerprint = hash(JSON.stringify(options));
  let offset = 0;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(args.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
      if (cursor.r !== revision) return invalid("Decision notes or their readable scope changed. Restart recall without cursor; do not combine pages from different revisions.");
      if (cursor.f !== fingerprint || !Number.isSafeInteger(cursor.o) || cursor.o < 0 || cursor.o > state.notes.length) throw new Error();
      offset = cursor.o;
    } catch { return invalid("Invalid recall cursor or changed filters/limit. Repeat the original filters and limit, or restart without cursor."); }
  }

  const found = searchNoteMatches(screened.safe, { ...options, offset });
  if (offset > found.totalMatched) return invalid("Invalid recall cursor. Restart without cursor.");
  const blocks = [];
  let used = 0, consumed = 0, returned = 0, oversized = 0;
  for (const note of found.matches) {
    const full = formatDecisionNote(note);
    const tooLarge = Buffer.byteLength(full) > BODY_BUDGET;
    // Advance past an oversized item without ever presenting a clipped decision
    // as a complete one. The canonical note remains intact in the YAML file.
    const block = tooLarge
      ? `> Result ${offset + consumed + 1} exceeds the response allowance; its contents were NOT returned. Review this note locally in decisions.yaml.`
      : full;
    const cost = Buffer.byteLength(block) + (blocks.length ? 2 : 0);
    if (used + cost > BODY_BUDGET) break;
    blocks.push(block);
    used += cost;
    consumed++;
    if (tooLarge) oversized++;
    else returned++;
  }

  const next = offset + consumed;
  const hasMore = next < found.totalMatched;
  const page = {
    revision, total_matched: found.totalMatched, returned, oversized,
    has_more: hasMore,
    next_cursor: hasMore ? Buffer.from(JSON.stringify({ r: revision, f: fingerprint, o: next })).toString("base64url") : null,
  };
  const warnings = [
    !state.ok ? "> Some entries could not be parsed and are not shown; this is an incomplete readable subset. The file was not changed." : "",
    screened.withheld.length ? `> ${screened.withheld.length} note(s) are withheld because they contain credential-shaped text; review the file locally.` : "",
    hasMore ? "> More matches remain. Repeat the same filters and limit with next_cursor; increasing limit alone is not pagination." : "",
  ].filter(Boolean).join("\n");
  let empty = "";
  if (!found.totalMatched) {
    const active = activeNotes(screened.safe).length;
    if (active) empty = `_No note matched that query or ID._ This installation has ${active} active note(s). Try different wording or omit query; do not infer that nothing was decided.`;
    else if (state.notes.length) empty = `_Nothing to show._ This installation has ${state.notes.length} recorded note(s), including superseded or withheld notes. Pass include_superseded: true to search history.`;
    else empty = "No decision notes have been recorded for this installation yet.";
  }
  const text = `# Decision notes (${returned} returned of ${found.totalMatched} matches)\n\n${warnings ? `${warnings}\n\n` : ""}${blocks.join("\n\n") || empty}\n\nPage: ${JSON.stringify(page)}`;
  if (Buffer.byteLength(text) > DECISION_RECALL_BUDGET_BYTES) return invalid("Recall could not fit its response budget; the stored notes were not changed. Use a narrower filter.");
  return { text, page };
}
