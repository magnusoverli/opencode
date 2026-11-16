// Adapted from @BBungalow's regression coverage in PR #210:
// https://github.com/magnusoverli/opencode/pull/210
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const addonRoot = join(__dirname, "..");
const patternFile = join(addonRoot, "rootfs/opt/shared/deprecation-patterns.json");

test("entity-id-in-data detects service data without matching event_data", async (t) => {
  const patterns = JSON.parse(readFileSync(patternFile, "utf8"));
  const rule = patterns.find((pattern) => pattern.id === "entity-id-in-data");
  assert.ok(rule, "entity-id-in-data deprecation pattern must exist");
  const regex = new RegExp(rule.pattern, rule.flags || "m");
  const cases = [
    ["service-call data.entity_id is detected", "action: light.turn_off\ndata:\n  entity_id: light.kitchen", true],
    ["event_data.entity_id is not detected", "trigger:\n  - platform: event\n    event_type: timer.finished\n    event_data:\n      entity_id: timer.boost", false],
    ["indented service-call data is detected", "script:\n  sequence:\n    - action: switch.turn_off\n      data:\n        entity_id: switch.plug", true],
    ["blank lines with LF are accepted", "action: light.turn_off\ndata:\n\n  entity_id: light.kitchen", true],
    ["CRLF and blank lines are accepted", "action: light.turn_off\r\ndata:\r\n\r\n  entity_id: light.kitchen", true],
    ["an unrelated suffixed key is not detected", "my_data:\n  entity_id: light.kitchen", false],
  ];
  for (const [name, yaml, expected] of cases) {
    await t.test(name, () => assert.equal(regex.test(yaml), expected));
  }
});

test("beta MCP and LSP pattern refreshes use beta rules rather than undoing beta-only fixes", () => {
  for (const server of ["ha-mcp-server/index.js", "ha-lsp-server/server.js"]) {
    const source = readFileSync(join(addonRoot, "rootfs/opt", server), "utf8");
    const url = source.match(/const GITHUB_PATTERNS_URL = "([^"]+)";/);
    assert.ok(url, `${server} must declare its pattern source`);
    assert.equal(url[1], "https://raw.githubusercontent.com/magnusoverli/opencode/main/ha_opencode_beta/rootfs/opt/shared/deprecation-patterns.json");
  }
});
