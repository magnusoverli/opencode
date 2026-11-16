import assert from "node:assert/strict";
import { test } from "node:test";
import { projectStoreAudit } from "../rootfs/opt/ha-mcp-server/lib/supervisor-operations.js";

test("store audit can reach all 117 entries without dropping installed apps (#199)", () => {
  const store = { addons: Array.from({ length: 117 }, (_, i) => ({
    slug: `app_${String(i).padStart(3, "0")}`, name: "Same name", installed: i > 100, update_available: i === 110,
  })).reverse(), repositories: [{ slug: "repo", source: "https://name:fixture-password@example.test/repo?token=fixture" }] };
  const seen = [];
  let offset = 0;
  do {
    const result = projectStoreAudit(store, { limit: 100, offset });
    assert.equal(result.apps.total, 117);
    assert.equal(result.apps.installed, 16);
    assert.ok(result.apps.returned <= 100);
    assert.doesNotMatch(JSON.stringify(result), /fixture-password|token=fixture/);
    seen.push(...result.apps.items);
    offset = result.next_offset;
  } while (offset !== null);
  assert.equal(new Set(seen.map(app => app.slug)).size, 117);
  assert.equal(seen.filter(app => app.installed).length, 16);
  assert.equal(seen[0].slug, "app_110");
  const end = projectStoreAudit(store, { limit: 100, offset: 1000 });
  assert.equal(end.apps.returned, 0);
  assert.equal(end.next_offset, null);
});
