import { describe, it, expect, vi } from "vitest";

import { formatErrorLogResult, readErrorLogWithFallback } from "../lib/ha-error-log.js";

describe("Home Assistant error-log fallback", () => {
  it("returns the file-backed error log when it is available", async () => {
    const readErrorLog = vi.fn(async () => "error log");
    const readCoreLogs = vi.fn(async () => "core journal");

    await expect(readErrorLogWithFallback({ readErrorLog, readCoreLogs, lines: 25 })).resolves.toEqual({
      text: "error log",
      source: "error_log",
    });
    expect(readCoreLogs).not.toHaveBeenCalled();
  });

  it("falls back to the Core journal only when the error-log endpoint is absent", async () => {
    const error = Object.assign(new Error("Not found"), { status: 404 });
    const readErrorLog = vi.fn(async () => { throw error; });
    const readCoreLogs = vi.fn(async () => "core journal");

    await expect(readErrorLogWithFallback({ readErrorLog, readCoreLogs, lines: 25 })).resolves.toEqual({
      text: "core journal",
      source: "core_journal",
    });
    expect(readCoreLogs).toHaveBeenCalledOnce();
    expect(readCoreLogs).toHaveBeenCalledWith(25);
  });

  it.each([401, 403, 500])("does not hide an HTTP %i error with a fallback", async (status) => {
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    const readErrorLog = vi.fn(async () => { throw error; });
    const readCoreLogs = vi.fn();

    await expect(readErrorLogWithFallback({ readErrorLog, readCoreLogs })).rejects.toBe(error);
    expect(readCoreLogs).not.toHaveBeenCalled();
  });

  it("does not fall back for a request failure without an HTTP status", async () => {
    const error = new Error("Timed out");
    const readErrorLog = vi.fn(async () => { throw error; });
    const readCoreLogs = vi.fn();

    await expect(readErrorLogWithFallback({ readErrorLog, readCoreLogs })).rejects.toBe(error);
    expect(readCoreLogs).not.toHaveBeenCalled();
  });

  it("propagates a Core journal fallback failure", async () => {
    const notFound = Object.assign(new Error("Not found"), { status: 404 });
    const fallbackError = new Error("Core journal unavailable");
    const readErrorLog = vi.fn(async () => { throw notFound; });
    const readCoreLogs = vi.fn(async () => { throw fallbackError; });

    await expect(readErrorLogWithFallback({ readErrorLog, readCoreLogs })).rejects.toBe(fallbackError);
  });

  it("labels a file-backed error-log response and reports local truncation", () => {
    expect(formatErrorLogResult({
      text: "first\nsecond\nthird",
      source: "error_log",
      requestedLines: 2,
      lines: 2,
    })).toEqual({
      summary: "Returned 2 Home Assistant error log lines",
      data: { log: "second\nthird" },
      meta: {
        requested_lines: 2,
        returned_lines: 2,
        source: "error_log",
        fallback_used: false,
        total_lines: 3,
        truncated: true,
        server_limited: false,
      },
    });
  });

  it("labels journal fallback output without claiming the full journal was read", () => {
    expect(formatErrorLogResult({
      text: "first\nsecond\nthird",
      source: "core_journal",
      requestedLines: 2,
      lines: 2,
    })).toEqual({
      summary: "Returned 2 Home Assistant Core journal lines (error log unavailable)",
      data: { log: "second\nthird" },
      meta: {
        requested_lines: 2,
        returned_lines: 2,
        source: "core_journal",
        fallback_used: true,
        total_lines: null,
        truncated: null,
        server_limited: true,
      },
    });
  });

  it("does not count a terminal newline as an extra log line", () => {
    expect(formatErrorLogResult({
      text: "first\nsecond\nthird\n",
      source: "error_log",
      requestedLines: 2,
      lines: 2,
    })).toEqual({
      summary: "Returned 2 Home Assistant error log lines",
      data: { log: "second\nthird" },
      meta: {
        requested_lines: 2,
        returned_lines: 2,
        source: "error_log",
        fallback_used: false,
        total_lines: 3,
        truncated: true,
        server_limited: false,
      },
    });
  });
});
