import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HA_LOGS = resolve(__dirname, "../../../usr/local/bin/ha-logs");

function findBash() {
  const candidates = process.platform === "win32"
    ? [
      process.env.BASH,
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    ]
    : ["bash"];

  return candidates.find((candidate) => {
    if (!candidate) return false;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    return !probe.error && probe.status === 0;
  });
}

const bash = findBash();
const describeWithBash = bash ? describe : describe.skip;

const CURL_MOCK = String.raw`curl() {
  local output="" arg next=0 url=""
  for arg in "$@"; do
    if [ "$next" = 1 ]; then
      output="$arg"
      next=0
      continue
    fi
    case "$arg" in
      -o) next=1 ;;
      *) url="$arg" ;;
    esac
  done

  case "$url" in
    */core/api/error_log)
      printf '%s\n' "$MOCK_PRIMARY_BODY" > "$output"
      printf '%s' "$MOCK_PRIMARY_STATUS"
      ;;
    */core/logs\?lines=7)
      printf '%s\n' "$MOCK_FALLBACK_BODY"
      ;;
    *)
      printf 'unexpected curl URL: %s\n' "$url" >&2
      return 12
      ;;
  esac
}

source "$1" error 7`;

function runHaLogs(primaryStatus) {
  return spawnSync(bash, ["-c", CURL_MOCK, "ha-logs-test", HA_LOGS], {
    encoding: "utf8",
    env: {
      ...process.env,
      SUPERVISOR_TOKEN: "test-token",
      MOCK_PRIMARY_STATUS: String(primaryStatus),
      MOCK_PRIMARY_BODY: "file log",
      MOCK_FALLBACK_BODY: "journal log",
    },
  });
}

function resultDetails(result) {
  return `stdout: ${JSON.stringify(result.stdout)}\nstderr: ${JSON.stringify(result.stderr)}\nerror: ${result.error?.message || "none"}`;
}

describeWithBash("ha-logs error", () => {
  it("returns the file-backed error log on a successful response", () => {
    const result = runHaLogs(200);

    expect(result.status, resultDetails(result)).toBe(0);
    expect(result.stdout).toBe("file log\n");
    expect(result.stderr).toBe("");
  });

  it("falls back to Core journal logs when the error-log endpoint returns 404", () => {
    const result = runHaLogs(404);

    expect(result.status, resultDetails(result)).toBe(0);
    expect(result.stdout).toBe("journal log\n");
    expect(result.stderr).toContain("error log is unavailable");
  });

  it("does not hide a non-404 failure with a fallback", () => {
    const result = runHaLogs(500);

    expect(result.status, resultDetails(result)).toBe(1);
    expect(result.stdout).toBe("file log\n");
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stdout).not.toContain("journal log");
  });
});
