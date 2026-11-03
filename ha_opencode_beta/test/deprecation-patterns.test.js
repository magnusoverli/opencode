import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const addonRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patternFile = join(addonRoot, "rootfs/opt/shared/deprecation-patterns.json");

test("entity-id-in-data detects service data without matching event_data", async (t) => {
  const patterns = JSON.parse(readFileSync(patternFile, "utf8"));
  const entityIdInData = patterns.find((pattern) => pattern.id === "entity-id-in-data");
  assert.ok(entityIdInData, "entity-id-in-data deprecation pattern must exist");

  const entityIdInDataRegex = new RegExp(entityIdInData.pattern, entityIdInData.flags || "m");

  assert.equal(entityIdInData.message, "Placing entity_id inside 'data:' is deprecated for service calls. Use 'target:' instead.");
  assert.equal(entityIdInData.deprecated_in, "2021.11");
  assert.equal(entityIdInData.severity, "warning");

  const cases = [
    ["service-call data.entity_id is detected", "action: light.turn_off\ndata:\n  entity_id: light.kitchen", true],
    ["event_data.entity_id is not detected", "trigger:\n  - platform: event\n    event_type: timer.finished\n    event_data:\n      entity_id: timer.boost", false],
    ["indented service-call data is detected", "script:\n  sequence:\n    - action: switch.turn_off\n      data:\n        entity_id: switch.plug", true],
    ["blank lines with LF are accepted", "action: light.turn_off\ndata:\n\n  entity_id: light.kitchen", true],
    ["CRLF and blank lines are accepted", "action: light.turn_off\r\ndata:\r\n\r\n  entity_id: light.kitchen", true],
    ["an unrelated suffixed key is not detected", "my_data:\n  entity_id: light.kitchen", false],
  ];

  for (const [name, yaml, expected] of cases) {
    await t.test(name, () => {
      assert.equal(entityIdInDataRegex.test(yaml), expected);
    });
  }
});
