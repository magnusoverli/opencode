import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const packageJsonUrl = new URL("../rootfs/opt/opencode-v2-homeassistant/package.json", import.meta.url);
const require = createRequire(packageJsonUrl);

test("brace-expansion resolves compatibly for both installed minimatch majors", () => {
  // minimatch@10.x (direct dependency) expects brace-expansion's named `expand` export.
  const top = require("minimatch");
  assert.deepEqual(top.braceExpand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);

  // rimraf -> glob -> minimatch@9.x expects brace-expansion's CommonJS default export;
  // pairing it with brace-expansion@5.x (which has no default export) throws
  // "TypeError: (0 , brace_expansion_1.default) is not a function" — this is the
  // regression a blanket `minimatch -> brace-expansion` override previously caused.
  // Resolve via a direct search path, since rimraf's own "exports" map blocks a
  // plain `require("rimraf/node_modules/minimatch")` subpath request.
  const nestedNodeModules = fileURLToPath(new URL("node_modules/rimraf/node_modules/", packageJsonUrl));
  const nestedMinimatchPath = require.resolve("minimatch", { paths: [nestedNodeModules] });
  const nested = require(nestedMinimatchPath);
  assert.deepEqual(nested.braceExpand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);
});
