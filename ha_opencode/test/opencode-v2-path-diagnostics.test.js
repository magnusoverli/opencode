import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("migration and terminal diagnostics identify unsafe paths without changing them", () => {
  const result = spawnSync("python3", ["-B", fileURLToPath(new URL("./fixtures/opencode-v2-path-diagnostics.py", import.meta.url))], {
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
