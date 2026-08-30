import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));

const expectedCli = packageJson.dependencies["@opencode-ai/cli"];
const expectedPlugin = packageJson.dependencies["@opencode-ai/plugin"];

assert.match(expectedCli, /^0\.0\.0-beta-\d+$/);
assert.equal(expectedPlugin, expectedCli, "CLI and plugin beta versions must match");
assert.equal(lock.packages["node_modules/@opencode-ai/cli"].version, expectedCli);
assert.equal(lock.packages["node_modules/@opencode-ai/plugin"].version, expectedPlugin);

console.log(`OpenCode V2 beta pins matching CLI/plugin beta ${expectedCli}`);
