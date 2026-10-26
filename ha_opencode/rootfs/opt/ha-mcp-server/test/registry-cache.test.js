import assert from "node:assert/strict";
import { test } from "vitest";
import { createRegistryCache } from "../lib/registry-cache.js";

test("registry reads cache until expiry and support targeted/full invalidation", async () => {
  let time = 0, reads = 0;
  const cache = createRegistryCache(async (type) => ({ type, read: ++reads }), { ttlMs: 100, now: () => time });
  assert.equal((await cache.get("areas")).read, 1);
  assert.equal((await cache.get("devices")).read, 2);
  time = 99;
  assert.equal((await cache.get("areas")).read, 1);
  cache.delete("areas");
  assert.equal((await cache.get("areas")).read, 3);
  assert.equal((await cache.get("devices")).read, 2);
  time = 100;
  assert.equal((await cache.get("devices")).read, 4);
  cache.clear();
  assert.equal((await cache.get("areas")).read, 5);
  assert.equal((await cache.get("devices")).read, 6);
});

for (const method of ["delete", "clear"]) {
  test(`${method} prevents a pre-edit in-flight read from repopulating the cache`, async () => {
    let release, reads = 0;
    const cache = createRegistryCache(() => ++reads === 1
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve("after"));
    const pending = cache.get("entities");
    cache[method]("entities");
    assert.equal(await cache.get("entities"), "after");
    release("before");
    assert.equal(await pending, "before", "Already-running callers retain their observed snapshot");
    assert.equal(await cache.get("entities"), "after", "Old snapshots must not replace fresh cached data");
    assert.equal(reads, 2);
  });
}

test("failed registry loads are not cached", async () => {
  let reads = 0;
  const cache = createRegistryCache(async () => {
    if (++reads === 1) throw new Error("offline");
    return [];
  });
  await assert.rejects(cache.get("devices"), /offline/);
  assert.deepEqual(await cache.get("devices"), []);
  assert.equal(reads, 2);
});
