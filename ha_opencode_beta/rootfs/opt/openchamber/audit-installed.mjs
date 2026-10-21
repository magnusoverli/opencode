// Audit the actual shipped Bun layout, not the full desktop/dev workspace lock.
// Only package names/versions are sent to npm's public advisory endpoint.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const packages = new Map();
const locations = new Map();
const visited = new Set();
async function entries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function readPackage(directory) {
  const real = await fs.realpath(directory);
  if (visited.has(real)) return;
  visited.add(real);
  const pkg = JSON.parse(await fs.readFile(path.join(real, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error("Incomplete installed package metadata");
  if (!packages.has(pkg.name)) { packages.set(pkg.name, new Set()); locations.set(pkg.name, []); }
  packages.get(pkg.name).add(pkg.version);
  locations.get(pkg.name).push(real);
  await readModules(path.join(real, "node_modules"));
}
async function readModules(directory) {
  for (const entry of await entries(directory)) {
    if (entry.name === ".bun") {
      for (const store of await entries(path.join(directory, entry.name))) {
        if (store.isDirectory()) await readModules(path.join(directory, entry.name, store.name, "node_modules"));
      }
    } else if (entry.name.startsWith("@")) {
      for (const pkg of await entries(path.join(directory, entry.name))) await readPackage(path.join(directory, entry.name, pkg.name));
    } else if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
      await readPackage(path.join(directory, entry.name));
    }
  }
}
const source = process.argv[2] || "/opt/openchamber-preview";
await readModules(path.join(source, "node_modules"));
await readPackage(path.join(source, "packages/web"));
await readPackage(path.join(source, "packages/sdk"));
if (packages.size < 20) throw new Error("Installed package inventory incomplete");
const response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(Object.fromEntries([...packages].map(([name, versions]) => [name, [...versions]]))),
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`Advisory service failed: ${response.status}`);
const result = await response.json();
if (!result || typeof result !== "object" || Array.isArray(result) || result.error) throw new Error("Invalid advisory service response");
const findings = [];
for (const [name, advisories] of Object.entries(result)) {
  if (!Array.isArray(advisories) || !packages.has(name)) throw new Error("Unexpected advisory response shape");
  for (const advisory of advisories) {
    let vendorMitigated = false;
    if (name === "braces" && advisory.url === "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" &&
        packages.get(name).size === 1 && packages.get(name).has("3.0.3")) {
      for (const directory of locations.get(name)) {
        const patch = JSON.parse(await fs.readFile(path.join(directory, "ha-depth-mitigation.json"), "utf8"));
        if (patch.advisory !== "GHSA-vfj7-8cjw-p6xm" || patch.version !== "3.0.3" || Object.keys(patch.hashes).length !== 4) throw new Error("Invalid braces mitigation manifest");
        for (const file of ["parse.js", "compile.js", "expand.js", "stringify.js"]) {
          const content = await fs.readFile(path.join(directory, "lib", file));
          if (createHash("sha256").update(content).digest("hex") !== patch.hashes[file]) throw new Error("Braces mitigation integrity check failed");
        }
      }
      vendorMitigated = true;
    }
    findings.push({ name, installed: [...packages.get(name)], severity: advisory.severity, url: advisory.url, vendorMitigated });
  }
}
const unmitigated = findings.filter(finding => !finding.vendorMitigated).length;
console.log(JSON.stringify({ scope: "installed OpenChamber package metadata; excludes OS packages and bundled browser code", packageNames: packages.size,
  nameVersionPairs: [...packages.values()].reduce((sum, versions) => sum + versions.size, 0),
  reportedAdvisories: findings.length, vendorMitigated: findings.length - unmitigated, unmitigated, findings }, null, 2));
process.exitCode = unmitigated ? 1 : 0;
