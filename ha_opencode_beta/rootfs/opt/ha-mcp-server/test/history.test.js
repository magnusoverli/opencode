import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_PAGE_LIMIT,
  projectHistoryValues,
  selectHistoryPage,
  summarizeNumericHistory,
} from "../lib/history.js";

function event(state, second) {
  return {
    state: String(state),
    last_changed: `2026-09-01T10:00:${String(second).padStart(2, "0")}.000Z`,
  };
}

describe("history paging", () => {
  const events = Array.from({ length: 10 }, (_, index) => event(index, index));

  it("pages backward from the newest events without changing page chronology", () => {
    const first = selectHistoryPage(events, { limit: 3 });
    expect(first.items.map(({ state }) => state)).toEqual(["7", "8", "9"]);
    expect(first).toMatchObject({
      page_from: "newest",
      offset: 0,
      next_offset: 3,
      has_more: true,
      first_event_index: 7,
      last_event_index: 9,
    });

    const second = selectHistoryPage(events, { limit: 3, offset: first.next_offset });
    expect(second.items.map(({ state }) => state)).toEqual(["4", "5", "6"]);
  });

  it("can traverse forward from the oldest event and clamps oversized pages", () => {
    const page = selectHistoryPage(events, { limit: 3, offset: 2, pageFrom: "oldest" });
    expect(page.items.map(({ state }) => state)).toEqual(["2", "3", "4"]);
    expect(page).toMatchObject({ page_from: "oldest", next_offset: 5, has_previous: true });

    expect(selectHistoryPage(events, { limit: MAX_HISTORY_PAGE_LIMIT + 1 }).limit)
      .toBe(MAX_HISTORY_PAGE_LIMIT);
  });

  it("retains the newest-200 default and can reconstruct all events oldest-first", () => {
    const manyEvents = Array.from({ length: 250 }, (_, index) => event(index, index % 60));
    const defaultPage = selectHistoryPage(manyEvents);
    expect(defaultPage.items).toHaveLength(200);
    expect(defaultPage.items[0].state).toBe("50");
    expect(defaultPage.items.at(-1).state).toBe("249");

    const states = [];
    let offset = 0;
    do {
      const page = selectHistoryPage(manyEvents, { limit: 80, offset, pageFrom: "oldest" });
      states.push(...page.items.map(({ state }) => state));
      if (page.next_offset === null) break;
      offset = page.next_offset;
    } while (true);
    expect(states).toEqual(manyEvents.map(({ state }) => state));
  });
});

describe("history projections and calculations", () => {
  it("summarizes every numeric event and identifies repeated extrema", () => {
    const events = [
      event("unknown", 0),
      event(5, 1),
      event(2, 2),
      event(5, 3),
    ];

    expect(summarizeNumericHistory(events, { scope: "complete_requested_window" })).toEqual({
      scope: "complete_requested_window",
      total_events: 4,
      numeric_events: 3,
      non_numeric_events: 1,
      sum: 12,
      sample_mean: 4,
      mean_kind: "arithmetic_sample_mean_not_time_weighted",
      calculation_status: "finite_double",
      minimum: {
        value: 2,
        timestamp: "2026-09-01T10:00:02.000Z",
        event_index: 2,
        occurrences: 1,
        last_timestamp: "2026-09-01T10:00:02.000Z",
      },
      maximum: {
        value: 5,
        timestamp: "2026-09-01T10:00:01.000Z",
        event_index: 1,
        occurrences: 2,
        last_timestamp: "2026-09-01T10:00:03.000Z",
      },
    });
  });

  it("projects compact state/timestamp pairs", () => {
    expect(projectHistoryValues([event(42, 4)])).toEqual([{
      state: "42",
      timestamp: "2026-09-01T10:00:04.000Z",
    }]);
  });

  it("uses last_updated as the recorded row timestamp", () => {
    expect(projectHistoryValues([{
      state: "42",
      last_changed: "2026-09-01T09:00:00.000Z",
      last_updated: "2026-09-01T10:00:04.000Z",
    }])).toEqual([{ state: "42", timestamp: "2026-09-01T10:00:04.000Z" }]);
  });

  it("reports numeric overflow instead of serializing an invalid sum", () => {
    const summary = summarizeNumericHistory([event("1e308", 1), event("1e308", 2)]);
    expect(summary).toMatchObject({
      numeric_events: 2,
      sum: null,
      sample_mean: null,
      calculation_status: "sum_overflow",
    });
  });
});
