export const DEFAULT_HISTORY_PAGE_LIMIT = 200;
export const MAX_HISTORY_PAGE_LIMIT = 1000;

const NUMERIC_STATE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function historyEventTimestamp(event) {
  return event?.last_updated ?? event?.last_changed ?? null;
}

export function selectHistoryPage(events, {
  offset = 0,
  limit = DEFAULT_HISTORY_PAGE_LIMIT,
  pageFrom = "newest",
} = {}) {
  const source = Array.isArray(events) ? events : [];
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), MAX_HISTORY_PAGE_LIMIT)
    : DEFAULT_HISTORY_PAGE_LIMIT;
  const fromNewest = pageFrom !== "oldest";
  const start = fromNewest
    ? Math.max(0, source.length - safeOffset - safeLimit)
    : Math.min(source.length, safeOffset);
  const end = fromNewest
    ? Math.max(start, source.length - safeOffset)
    : Math.min(source.length, start + safeLimit);
  const items = source.slice(start, end);
  const hasMore = fromNewest ? start > 0 : end < source.length;

  return {
    items,
    offset: safeOffset,
    limit: safeLimit,
    page_from: fromNewest ? "newest" : "oldest",
    first_event_index: items.length > 0 ? start : null,
    last_event_index: items.length > 0 ? end - 1 : null,
    has_more: hasMore,
    next_offset: hasMore ? safeOffset + items.length : null,
    has_previous: safeOffset > 0,
    previous_offset: safeOffset > 0 ? Math.max(0, safeOffset - safeLimit) : null,
  };
}

export function summarizeNumericHistory(events, { scope = "home_assistant_default_history" } = {}) {
  const source = Array.isArray(events) ? events : [];
  let count = 0;
  let sum = 0;
  let sumFinite = true;
  let precisionLossPossible = false;
  let minimum;
  let maximum;

  for (let index = 0; index < source.length; index += 1) {
    const event = source[index];
    const rawState = typeof event?.state === "string" ? event.state.trim() : "";
    if (!NUMERIC_STATE.test(rawState)) continue;
    const value = Number(rawState);
    if (!Number.isFinite(value)) continue;

    count += 1;
    if (sumFinite) {
      const nextSum = sum + value;
      if (Number.isFinite(nextSum)) sum = nextSum;
      else sumFinite = false;
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) precisionLossPossible = true;
    const occurrence = { value, timestamp: historyEventTimestamp(event), event_index: index };
    if (!minimum || value < minimum.value) {
      minimum = { ...occurrence, occurrences: 1, last_timestamp: occurrence.timestamp };
    } else if (value === minimum.value) {
      minimum.occurrences += 1;
      minimum.last_timestamp = occurrence.timestamp;
    }
    if (!maximum || value > maximum.value) {
      maximum = { ...occurrence, occurrences: 1, last_timestamp: occurrence.timestamp };
    } else if (value === maximum.value) {
      maximum.occurrences += 1;
      maximum.last_timestamp = occurrence.timestamp;
    }
  }

  return {
    scope,
    total_events: source.length,
    numeric_events: count,
    non_numeric_events: source.length - count,
    sum: count > 0 && sumFinite ? sum : null,
    sample_mean: count > 0 && sumFinite ? sum / count : null,
    mean_kind: "arithmetic_sample_mean_not_time_weighted",
    calculation_status: count === 0
      ? "no_numeric_values"
      : (!sumFinite ? "sum_overflow" : (precisionLossPossible ? "precision_loss_possible" : "finite_double")),
    minimum: minimum ?? null,
    maximum: maximum ?? null,
  };
}

export function projectHistoryValues(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    state: event?.state ?? null,
    timestamp: historyEventTimestamp(event),
  }));
}
