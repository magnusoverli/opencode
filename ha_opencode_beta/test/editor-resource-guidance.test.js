const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

test("editor-resource guidance does not mandate whole-file replacement or permit in-place YAML bypass (#215)", () => {
  const root = join(__dirname, "../rootfs/opt/ha-mcp-server");
  const global = readFileSync(join(root, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(root, "skills/home-assistant-configuration/SKILL.md"), "utf8");
  for (const text of [global, skill]) {
    assert.match(text, /resource ownership/);
    assert.match(text, /complete individual\s+resource/);
    assert.match(text, /complete-file `write_config_safe`/i);
    assert.match(text, /`patch_config_safe`/);
    assert.match(text, /expected_revision/);
    assert.match(text, /expected_candidate/);
    assert.match(text, /automatic reload/);
    assert.match(text, /activation/);
    assert.match(text, /never bypass/i);
    assert.doesNotMatch(text, /including for UI-managed|yq -i` is for quick/);
  }
  assert.match(skill, /supported revision guards/);
  assert.match(skill, /best-effort concurrency/);
  assert.match(skill, /not atomic stale-resource protection/);
  assert.match(skill, /No separate whole-file/);
  assert.match(skill, /recoverable backup/);
  assert.match(skill, /never in-place writes/);
  assert.doesNotMatch(skill, /yq -i '/);
});
