/** Exact, bounded byte-preserving edits. Never parse and reserialize YAML. */
export function applyConfigTextPatch(source, edits) {
  if (typeof source !== "string" || !Array.isArray(edits) || !edits.length || edits.length > 20) throw new Error("invalid_edits");
  const ranges = [];
  for (const edit of edits) {
    if (!edit || typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text || Buffer.byteLength(edit.old_text) + Buffer.byteLength(edit.new_text) > 16384) throw new Error("invalid_edit");
    const start = source.indexOf(edit.old_text);
    if (start < 0 || source.indexOf(edit.old_text, start + 1) !== -1) throw new Error("match_not_unique");
    ranges.push({ start, end: start + edit.old_text.length, text: edit.new_text });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i && range.start < ranges[i - 1].end)) throw new Error("overlapping_edits");
  let result = "", cursor = 0;
  for (const range of ranges) {
    result += source.slice(cursor, range.start) + range.text;
    cursor = range.end;
  }
  return result + source.slice(cursor);
}
