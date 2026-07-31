/**
 * Read the Home Assistant error log, falling back to the Core journal only
 * when Supervisor reports that the file-backed error-log endpoint is absent.
 */
export async function readErrorLogWithFallback({
  readErrorLog,
  readCoreLogs,
  lines = 100,
} = {}) {
  if (typeof readErrorLog !== "function" || typeof readCoreLogs !== "function") {
    throw new TypeError("readErrorLog and readCoreLogs functions are required");
  }

  try {
    return {
      text: await readErrorLog(),
      source: "error_log",
    };
  } catch (error) {
    if (error?.status !== 404) throw error;

    return {
      text: await readCoreLogs(lines),
      source: "core_journal",
    };
  }
}

/**
 * Build a transparent MCP payload for either the error-log file or the
 * Supervisor-backed Core journal fallback.
 */
export function formatErrorLogResult({ text, source, requestedLines, lines }) {
  const allLines = String(text ?? "").split("\n");
  if (allLines.at(-1) === "") allLines.pop();
  const logLines = allLines.slice(-lines);
  const usingCoreJournal = source === "core_journal";

  return {
    summary: `Returned ${logLines.length} Home Assistant ${usingCoreJournal ? "Core journal" : "error log"} lines${usingCoreJournal ? " (error log unavailable)" : ""}`,
    data: { log: logLines.join("\n") },
    meta: {
      requested_lines: requestedLines,
      returned_lines: logLines.length,
      source,
      fallback_used: usingCoreJournal,
      total_lines: usingCoreJournal ? null : allLines.length,
      truncated: usingCoreJournal ? null : allLines.length > logLines.length,
      server_limited: usingCoreJournal,
    },
  };
}
