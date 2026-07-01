import { describe, it, expect } from "vitest";
import {
  createCompactPayload,
  createJsonTextContent,
  truncateLines,
  truncateText,
} from "../lib/helpers.js";

describe("MCP helper utilities", () => {
  it("creates compact JSON text content for compatibility clients", () => {
    const content = createJsonTextContent(
      createCompactPayload("Found devices", [{ id: "abc" }], { total: 1 }),
      { pretty: true, audience: ["assistant"], priority: 0.7 }
    );

    expect(content.type).toBe("text");
    expect(content.annotations).toEqual({ audience: ["assistant"], priority: 0.7 });
    expect(JSON.parse(content.text)).toEqual({
      summary: "Found devices",
      data: [{ id: "abc" }],
      meta: { total: 1 },
    });
  });

  it("truncates long text while keeping head and tail", () => {
    const result = truncateText("a".repeat(50) + "MIDDLE" + "z".repeat(50), {
      maxChars: 60,
      headChars: 15,
    });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(60);
    expect(result.text.startsWith("a".repeat(15))).toBe(true);
    expect(result.text).toContain("chars omitted");
    expect(result.text.endsWith("z".repeat(10))).toBe(true);
    expect(result.omitted_chars).toBeGreaterThan(0);
  });

  it("truncates long line lists with an omission marker", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
    const result = truncateLines(lines, { maxLines: 5, headLines: 2 });

    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual([
      "line-1",
      "line-2",
      "... 5 lines omitted ...",
      "line-8",
      "line-9",
      "line-10",
    ]);
    expect(result.original_lines).toBe(10);
    expect(result.omitted_lines).toBe(5);
  });
});
