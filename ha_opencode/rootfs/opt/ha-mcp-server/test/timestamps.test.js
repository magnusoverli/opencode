import { describe, expect, it } from "vitest";

import { requireTimezoneAwareTimestamp } from "../lib/timestamps.js";

describe("timezone-aware timestamp validation", () => {
  it.each([
    "2026-08-07T04:00:00Z",
    "2026-08-07T04:00:00.123456Z",
    "2026-08-07T04:00:00+02:00",
    "2026-08-07T04:00:00-07:00",
    "2026-08-07T04:00:00+14:00",
    "2024-02-29T04:00:00Z",
  ])("preserves an explicit RFC 3339 instant verbatim: %s", (value) => {
    expect(requireTimezoneAwareTimestamp(value, "start_time")).toBe(value);
  });

  it.each([
    "2026-08-07T04:00:00",
    "2026-08-07 04:00:00Z",
    "2026-08-07T04:00Z",
    "2026-08-07",
    "2026-08-07T04:00:00+0200",
    "2026-08-07T04:00:00+14:01",
    "2026-08-07T04:00:00z",
    "2026-08-07T04:00:00Z?end_time=unexpected",
    "2026-02-29T04:00:00Z",
    "2026-04-31T04:00:00Z",
    "0000-01-01T00:00:00Z",
    " 2026-08-07T04:00:00Z",
    "2026-08-07T04:00:00Z ",
  ])("rejects ambiguous or malformed input: %s", (value) => {
    expect(() => requireTimezoneAwareTimestamp(value, "end_time"))
      .toThrow("end_time must be a timezone-aware RFC 3339 timestamp");
  });

  it("identifies the rejected field in the error", () => {
    expect(() => requireTimezoneAwareTimestamp("2026-08-07T04:00:00", "start"))
      .toThrow(/^start must be a timezone-aware RFC 3339 timestamp/);
  });
});
