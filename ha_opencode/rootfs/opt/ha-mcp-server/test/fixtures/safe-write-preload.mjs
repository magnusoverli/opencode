// Subprocess-only fixture: redirect /homeassistant into a disposable directory
// and replace all HA/network calls. Never loaded by the packaged MCP server.
import fs from "node:fs";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const root = process.env.SAFE_WRITE_FIXTURE_ROOT;
if (!root) throw new Error("Missing safe-write fixture root");
const original = Object.fromEntries(["readFileSync", "writeFileSync", "copyFileSync", "unlinkSync", "existsSync", "mkdirSync", "appendFileSync"].map(name => [name, fs[name]]));
const state = () => JSON.parse(original.readFileSync(join(root, "state.json"), "utf8"));
const record = event => original.appendFileSync(join(root, "trace.jsonl"), JSON.stringify(event) + "\n");
const translate = file => typeof file === "string" && (file === "/homeassistant" || file.startsWith("/homeassistant/"))
  ? join(root, "config", file.slice("/homeassistant".length)) : file;
const inConfig = file => translate(file) !== file;

for (const name of ["readFileSync", "existsSync"]) fs[name] = (file, ...args) => original[name](translate(file), ...args);
for (const name of ["writeFileSync", "unlinkSync", "mkdirSync"]) fs[name] = (file, ...args) => {
  if (inConfig(file)) record({ operation: name, path: file });
  return original[name](translate(file), ...args);
};
fs.copyFileSync = (from, to, ...args) => {
  if (inConfig(from) || inConfig(to)) {
    record({ operation: "copyFileSync", from, to });
    if (state().backupFailure && String(to).endsWith(".bak")) throw new Error("Synthetic backup failure");
  }
  return original.copyFileSync(translate(from), translate(to), ...args);
};
// The current repair helper uses a fixed Supervisor WebSocket hostname. Fail
// DNS locally rather than allowing this test subprocess onto a real network.
dns.lookup = (_host, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  queueMicrotask(() => done(Object.assign(new Error("Synthetic offline DNS"), { code: "ENOTFOUND" })));
};
syncBuiltinESMExports();

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const current = state();
  if (url.pathname.endsWith("deprecation-patterns.json")) return Response.json([{ pattern: "a^", message: "Synthetic non-match" }]);
  if (url.pathname.endsWith("/template")) {
    const { template } = JSON.parse(options.body);
    record({ operation: "template", template });
    if (template.includes("BROKEN")) return new Response("Error rendering template: TemplateSyntaxError: Synthetic syntax error", { status: 400 });
    return new Response("Synthetic rendered value");
  }
  if (url.pathname.endsWith("/config/core/check_config")) {
    record({ operation: "check_config" });
    if (current.check === "unavailable") throw new Error("Synthetic HA outage");
    return Response.json({ result: current.check ?? "valid", errors: current.check === "invalid" ? "Synthetic invalid configuration" : "" });
  }
  return Response.json([]);
};
