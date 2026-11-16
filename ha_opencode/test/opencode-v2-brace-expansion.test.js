import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const packageJsonUrl = new URL("../rootfs/opt/opencode-v2-homeassistant/package.json", import.meta.url);
const require = createRequire(packageJsonUrl);

test("the patched minimatch and glob pair shares a compatible brace-expansion", () => {
  const top = require("minimatch");
  assert.deepEqual(top.braceExpand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);

  // Upgrade glob alongside minimatch: glob 10/13 depend on APIs removed in
  // minimatch 11. Do not fix this by overriding brace-expansion alone; that
  // previously broke older minimatch's CommonJS default-export assumption.
  const fromRimraf = createRequire(require.resolve("rimraf"));
  const fromGlob = createRequire(fromRimraf.resolve("glob"));
  assert.equal(fromGlob("minimatch/package.json").version, "11.0.1");
  assert.deepEqual(fromGlob("minimatch").braceExpand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);
  assert.equal(fromGlob.resolve("minimatch"), require.resolve("minimatch"));
});
