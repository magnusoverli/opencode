import { describe, it, expect } from "vitest";
import { applyConfigTextPatch } from "../lib/config-text-patch.js";

describe("exact config patches", () => {
  it("preserves unrelated bytes, tags, line endings and large content", () => {
    const prefix = "# untouched\r\n" + "x".repeat(250000) + "\r\n- !secret key\r\n";
    expect(applyConfigTextPatch(prefix + "- remove me\r\n", [{ old_text: "- remove me\r\n", new_text: "" }])).toBe(prefix);
  });
  it("rejects absent, repeated, empty and overlapping matches", () => {
    expect(() => applyConfigTextPatch("abc abc", [{ old_text: "abc", new_text: "x" }])).toThrow("match_not_unique");
    expect(() => applyConfigTextPatch("abc", [{ old_text: "z", new_text: "" }])).toThrow("match_not_unique");
    expect(() => applyConfigTextPatch("abc", [{ old_text: "", new_text: "x" }])).toThrow("invalid_edit");
    expect(() => applyConfigTextPatch("abc", [{ old_text: "ab", new_text: "" }, { old_text: "bc", new_text: "" }])).toThrow("overlapping_edits");
  });
});
