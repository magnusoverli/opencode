import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url);
const require = createRequire(new URL("package.json", root));

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "ha-dependency-security-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("all locked glob/minimatch instances use the reviewed security fixes", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("package.json", root)));
  const lock = JSON.parse(fs.readFileSync(new URL("package-lock.json", root)));
  for (const [name, version] of Object.entries({ glob: "14.0.2", minimatch: "11.0.1" })) {
    assert.equal(manifest.overrides[name], version);
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    assert.ok(entries.length > 0);
    for (const [path, entry] of entries) assert.equal(entry.version, version, path);
    assert.equal(require(`${name}/package.json`).version, version);
  }
});

test("patched OpenCode glob utility preserves scans, ignores, dotfiles and symlink policy", async t => {
  const path = await fixture(t);
  await mkdir(join(path, "nested"));
  await mkdir(join(path, "ignored"));
  for (const file of ["top.js", "nested/child.js", "ignored/private.js", ".hidden.js"]) await writeFile(join(path, file), "fixture");
  fs.symlinkSync(join(path, "nested"), join(path, "link"));
  const { Glob } = await import(new URL("node_modules/@opencode/util/dist/glob.js", root));
  const options = { cwd: path, ignore: ["ignored/**", "link/**"], symlink: false };
  assert.deepEqual((await Glob.scan("**/*.js", options)).sort(), ["nested/child.js", "top.js"]);
  // OpenCode 2.2 removed its scanSync wrapper; glob's public sync API remains.
  assert.deepEqual(require("glob").globSync("**/*.js", options).sort(), ["nested/child.js", "top.js"]);
  assert.ok((await Glob.scan("**/*.js", { ...options, dot: true })).includes(".hidden.js"));
  assert.equal(Glob.match("**/*.js", ".hidden.js"), true);
  assert.equal(Glob.match("**/*.js", "nested/file.txt"), false);
});

test("npm workspace discovery and package packing work with the patched matching APIs", async t => {
  const path = await fixture(t);
  const pkg = { name: "dependency-fixture", version: "1.0.0", workspaces: ["packages/*", "!packages/excluded"] };
  await writeFile(join(path, "package.json"), JSON.stringify(pkg));
  for (const name of ["kept", "excluded"]) {
    await mkdir(join(path, "packages", name), { recursive: true });
    await writeFile(join(path, "packages", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  const mapWorkspaces = require("@npmcli/map-workspaces");
  assert.deepEqual([...await mapWorkspaces({ cwd: path, pkg })], [["kept", join(path, "packages/kept")]]);

  const packRoot = join(path, "pack");
  await mkdir(join(packRoot, "lib"), { recursive: true });
  await writeFile(join(packRoot, "package.json"), JSON.stringify({ name: "packed-fixture", version: "1.0.0", files: ["lib/"] }));
  await writeFile(join(packRoot, "lib/index.js"), "export default 1;");
  await writeFile(join(packRoot, "lib/private.txt"), "excluded fixture");
  await writeFile(join(packRoot, "lib/.npmignore"), "private.txt\n");
  const Arborist = require("@npmcli/arborist");
  const tree = await new Arborist({ path: packRoot }).loadActual();
  const files = await require("npm-packlist")(tree);
  assert.deepEqual(files.sort(), ["lib/index.js", "package.json"]);
  const tarball = await require("pacote").tarball(packRoot, { Arborist, cache: join(path, "cache"), ignoreScripts: true });
  assert.ok(tarball.length > 0);
  const cacache = require("cacache");
  const cache = join(path, "cache");
  await cacache.put(cache, "matching-fixture", "fixture bytes");
  await cacache.verify(cache);
  assert.equal((await cacache.get(cache, "matching-fixture")).data.toString(), "fixture bytes");
});

test("TUF delegated paths retain their per-segment matching boundary", () => {
  const { DelegatedRole } = require("@tufjs/models/dist/role.js");
  const role = new DelegatedRole({ name: "fixture", keyIDs: ["fixture-key"], threshold: 1,
    terminating: true, paths: ["packages/*.tgz"] });
  assert.equal(role.isDelegatedPath("packages/example.tgz"), true);
  assert.equal(role.isDelegatedPath("elsewhere/example.tgz"), false);
  assert.equal(role.isDelegatedPath("packages/nested/example.tgz"), false);
});

test("rimraf glob expansion deletes only selected fixture files", async t => {
  const path = await fixture(t);
  for (const file of ["remove-a.tmp", "remove-b.tmp", "keep.txt"]) await writeFile(join(path, file), "fixture");
  const { rimraf } = require("rimraf");
  assert.equal(await rimraf(join(path, "remove-*.tmp"), { glob: true }), true);
  assert.deepEqual(fs.readdirSync(path), ["keep.txt"]);
});

test("glob cancellation stops recursive reads after the first aborted directory read", async t => {
  const path = await fixture(t);
  await mkdir(join(path, "child/grandchild"), { recursive: true });
  await writeFile(join(path, "child/grandchild/file.js"), "fixture");
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  let reads = 0;
  const io = { ...fs, readdir(directory, options, callback) {
    reads++;
    fs.readdir(directory, options, (error, entries) => {
      controller.abort(reason);
      callback(error, entries);
    });
  } };
  await assert.rejects(require("glob").glob("**/*.js", { cwd: path, fs: io, signal: controller.signal }), error => error === reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "aborted traversal must not start reading child directories");
});

test("minimatch bounds globparts amplification at optimization level two", () => {
  // GHSA-g3hv-75wg-m249: **/.. repeatedly clones globParts. Run in a
  // time-bounded child so reintroducing a vulnerable version cannot hang CI.
  const entry = require.resolve("minimatch");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { Minimatch } from ${JSON.stringify(pathToFileURL(entry).href)};
    const pattern = 'a/**/../'.repeat(18) + 'b/c';
    const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 32 });
    assert.ok(matcher.globParts.length <= 32);
  `], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
