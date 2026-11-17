import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("legacy inventory and reviewed cache quarantine preserve concurrent writes and active/user state", () => {
  const result = spawnSync(process.env.PYTHON || "python3",
    ["-B", fileURLToPath(new URL("./fixtures/opencode-v2-legacy-data.py", import.meta.url))],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
