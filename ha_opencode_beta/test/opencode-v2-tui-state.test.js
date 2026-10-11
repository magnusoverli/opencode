import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("durable TUI atomic writes and root-owned configuration/plugin boundary", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./fixtures/opencode-v2-tui-state.py", import.meta.url))], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
