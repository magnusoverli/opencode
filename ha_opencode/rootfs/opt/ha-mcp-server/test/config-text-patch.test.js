// Based on @jameswgm87's PR #213 tests, extended for integration boundaries.
import { describe, it, expect } from "vitest";
import { applyConfigTextPatch } from "../lib/config-text-patch.js";

describe("exact config patches", () => {
  it("preserves unrelated bytes, tags, Unicode, line endings and large content", () => {
    const prefix = "# untouched café 🏠\r\n" + "x".repeat(250000) + "\r\n- !secret key\r\n";
    expect(Buffer.from(applyConfigTextPatch(prefix + "- remove me\r\n", [
      { old_text: "- remove me\r\n", new_text: "" },
    ]))).toEqual(Buffer.from(prefix));
  });

  it("applies unsorted edits against the original, not replacements from preceding edits", () => {
    expect(applyConfigTextPatch("one two three", [
      { old_text: "three", new_text: "one" },
      { old_text: "one", new_text: "two" },
      { old_text: "two", new_text: "three" },
    ])).toBe("two three one");
    expect(applyConfigTextPatch("abcd", [
      { old_text: "ab", new_text: "x" }, { old_text: "cd", new_text: "y" },
    ])).toBe("xy");
  });

  it("rejects absent, repeated, empty and overlapping matches", () => {
    expect(() => applyConfigTextPatch("abc abc", [{ old_text: "abc", new_text: "x" }])).toThrow("match_not_unique");
    expect(() => applyConfigTextPatch("aaa", [{ old_text: "aa", new_text: "x" }])).toThrow("match_not_unique");
    expect(() => applyConfigTextPatch("abc", [{ old_text: "z", new_text: "" }])).toThrow("match_not_unique");
    expect(() => applyConfigTextPatch("abc", [{ old_text: "", new_text: "x" }])).toThrow("invalid_edit");
    expect(() => applyConfigTextPatch("abc", [
      { old_text: "ab", new_text: "" }, { old_text: "bc", new_text: "" },
    ])).toThrow("overlapping_edits");
  });

  it("bounds edit counts and UTF-8 bytes including both sides of each edit", () => {
    expect(() => applyConfigTextPatch("a", [])).toThrow("invalid_edits");
    expect(() => applyConfigTextPatch("a", Array(21).fill({ old_text: "a", new_text: "b" }))).toThrow("invalid_edits");
    expect(() => applyConfigTextPatch("a", [null])).toThrow("invalid_edit");
    expect(() => applyConfigTextPatch("a", [{ old_text: "a", new_text: 1 }])).toThrow("invalid_edit");
    expect(applyConfigTextPatch("a", [{ old_text: "a", new_text: "b".repeat(16383) }])).toHaveLength(16383);
    expect(() => applyConfigTextPatch("a", [{ old_text: "a", new_text: "b".repeat(16384) }])).toThrow("invalid_edit");
    expect(() => applyConfigTextPatch("a", [{ old_text: "a", new_text: "é".repeat(8192) }])).toThrow("invalid_edit");
  });
});
