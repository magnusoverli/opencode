// Offline: only local schema/guide discovery, never a documented operation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [binary = "/usr/local/bin/hab", instructions = "/opt/ha-mcp-server/INSTRUCTIONS.md"] = process.argv.slice(2);
function discover(args) {
  const result = JSON.parse(execFileSync(binary, ["--skip-update-check", "--json", ...args],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000 }));
  assert.equal(result.success, true);
  return result.data;
}
const root = discover(["schema"]);
const paths = new Set();
function visit(node) {
  paths.add(node.path);
  node.subcommands?.forEach(visit);
}
visit(root);
const guides = new Set(discover(["guide", "list"]).map(topic => topic.id));
const docs = readFileSync(instructions, "utf8");
const taskMap = docs.split("### HAB task routing")[1].split("\n### ")[0];
const families = new Set();
for (const line of taskMap.split("\n").filter(line => line.startsWith("|"))) {
  for (const [, path] of (line.split("|")[2] || "").matchAll(/`([^`]+)`/g)) {
    assert.ok(paths.has(`hab ${path}`), `Unknown HAB family or command: ${path}`);
    families.add(path.split(" ")[0]);
  }
}
assert.deepEqual([...families].sort(), root.subcommands.map(node => node.path.slice(4)).sort(),
  "Route every shipped HAB family, including families deliberately blocked by the gateway");
for (const [, literal] of docs.matchAll(/^hab_run\(args=(\[.*\])\)$/gm)) {
  const [command, ...args] = JSON.parse(literal);
  if (command === "guide" && args[0] !== "list") assert.ok(guides.has(args[0]), `Unknown guide: ${args[0]}`);
  if (command === "schema" && args.length && !args[0].startsWith("-")) {
    const path = ["hab", ...args.filter(arg => !arg.startsWith("-"))].join(" ");
    assert.ok(paths.has(path), `Unknown schema example: ${path}`);
  }
}
console.log(`Verified HAB routing for ${families.size} command families against the installed CLI.`);
