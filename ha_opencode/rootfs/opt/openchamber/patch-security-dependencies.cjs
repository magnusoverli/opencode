const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
if (!root) throw new Error("Provide the pinned OpenChamber source directory");
const file = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (pkg.name !== "openchamber-monorepo" || pkg.version !== "2.5.2") {
  throw new Error("Review dependency overrides for this OpenChamber release");
}
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, "security-overrides.json"), "utf8"));
for (const [name, version] of Object.entries(overrides)) {
  if (Object.hasOwn(pkg.overrides || {}, name)) throw new Error(`Upstream already overrides ${name}; review before replacing it`);
  pkg.overrides[name] = version;
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
// simple-git 4 exposes the factory as a named export, including in native ESM.
for (const name of ["service.js", "service.test.js"]) {
  const file = path.join(root, "packages/web/server/lib/git", name);
  const source = fs.readFileSync(file, "utf8");
  const before = "import simpleGit from 'simple-git';";
  if (source.split(before).length !== 2) throw new Error(`Review simple-git imports in ${name}`);
  let updated = source.replace(before, "import { simpleGit } from 'simple-git';");
  if (name === "service.js") {
    const anchor = "  return createSimpleGit({\n    baseDir,";
    if (updated.split(anchor).length !== 2) throw new Error("Review Git environment policy");
    updated = updated.replace(anchor, "  return createSimpleGit({\n    // Permit unchanged trusted server settings and app-owned controls, never a project override.\n    allowEnvironment: [...Object.keys(env).filter(key => env[key] === process.env[key]), 'GIT_TERMINAL_PROMPT', 'GIT_INDEX_FILE', 'GIT_LITERAL_PATHSPECS', 'GIT_OPTIONAL_LOCKS'],\n    baseDir,");
  } else {
    // Git 2.47 (Debian trixie) does not auto-create remote HEAD on fetch.
    // Establish the test's local symbolic-ref precondition explicitly.
    const anchor = "    addOptionLikeRemote(repository, remote);\n    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();";
    if (updated.split(anchor).length !== 2) throw new Error("Review option-like remote fixture");
    updated = updated.replace(anchor, "    addOptionLikeRemote(repository, remote);\n    runGit(repository, ['symbolic-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/HEAD`, `refs/remotes/${OPTION_LIKE_REMOTE}/react`]);\n    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();");
  }
  fs.writeFileSync(file, updated);
}
console.log(`Applied ${Object.keys(overrides).length} explicit security dependency pins`);
