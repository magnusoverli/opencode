const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
if (!root) throw new Error("Provide the pinned OpenChamber source directory");
const file = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (pkg.name !== "openchamber-monorepo" || pkg.version !== "2.5.3") {
  throw new Error("Review dependency overrides for this OpenChamber release");
}
// 2.5.3 implements Git 4's named import, own-key environment propagation and
// project-variable filtering upstream. Do not apply the obsolete 2.5.0 service
// rewrite over this policy. Fail closed if the reviewed implementation drifts.
const gitSource = fs.readFileSync(path.join(root, "packages/web/server/lib/git/service.js"), "utf8");
for (const anchor of ["import { simpleGit } from 'simple-git';", "const simpleGitEnvOptions = (env) => {",
  "return { allowEnvironment: Object.keys(env), unsafe };", "!isKeptOutOfGitOverlay(name)",
  "env.GIT_OPTIONAL_LOCKS = '0';", "}).env(env);"]) {
  if (gitSource.split(anchor).length !== 2) throw new Error("Review upstream Git 4 environment policy");
}
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, "security-overrides.json"), "utf8"));
for (const [name, version] of Object.entries(overrides)) {
  if (Object.hasOwn(pkg.overrides || {}, name)) throw new Error(`Upstream already overrides ${name}; review before replacing it`);
  pkg.overrides[name] = version;
}
// This upstream trust test creates a fake gh executable but omits the PATH
// setup its neighboring tests use. Supply that fixture precondition, never a
// production trust/auth bypass or a skipped assertion. Validate before writes.
const testFile = path.join(root, "packages/web/server/lib/github/octokit.test.js");
const testSource = fs.readFileSync(testFile, "utf8");
const marker = "  test('resolves a trusted enterprise host cli account id to a host-pinned octokit only after the instance is activated', async () => {";
if (testSource.split(marker).length !== 2) throw new Error("Review upstream enterprise-account fixture");
const start = testSource.indexOf(marker);
const end = testSource.indexOf("\n  test(", start + marker.length);
if (end === -1) throw new Error("Review upstream enterprise-account fixture boundary");
const original = testSource.slice(start, end);
let fixed = original;
for (const [before, after] of [
  ["    const previousFetch = globalThis.fetch;", "    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;\n    const previousFetch = globalThis.fetch;"],
  ["      globalThis.fetch = previousFetch;", "      globalThis.fetch = previousFetch;\n      if (previousPath === undefined) delete process.env.PATH;\n      else process.env.PATH = previousPath;"],
]) {
  if (fixed.split(before).length !== 2) throw new Error("Review upstream enterprise-account fixture setup");
  fixed = fixed.replace(before, after);
}
if (original.includes("process.env.PATH =")) throw new Error("Upstream enterprise fixture already supplies PATH; review before patching");
// Git 2.47 in Debian trixie does not create a remote HEAD during this fetch.
// Establish the fixture's symbolic-ref precondition explicitly, retaining all
// branch discovery, pruning and option-like remote security assertions.
const serviceTestFile = path.join(root, "packages/web/server/lib/git/service.test.js");
const serviceTestSource = fs.readFileSync(serviceTestFile, "utf8");
const remoteBefore = "    addOptionLikeRemote(repository, remote);\n    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();";
if (serviceTestSource.split(remoteBefore).length !== 2) throw new Error("Review option-like remote HEAD fixture");
const remoteAfter = "    addOptionLikeRemote(repository, remote);\n    runGit(repository, ['symbolic-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/HEAD`, `refs/remotes/${OPTION_LIKE_REMOTE}/react`]);\n    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();";
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(testFile, testSource.slice(0, start) + fixed + testSource.slice(end));
fs.writeFileSync(serviceTestFile, serviceTestSource.replace(remoteBefore, remoteAfter));
console.log(`Applied ${Object.keys(overrides).length} explicit security dependency pins`);
