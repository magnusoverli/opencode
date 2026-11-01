/** Reviewed against HAB 1.7.2, commit 0bc138c6ab9f1bbe87914a0ffccbb038c0767e82:
 * cmd/dashboard_{list,get}.go and cmd/helper_{list,types}.go. Do not widen this
 * policy using side-effect annotations, aliases or a --plan flag.
 */
import { prepareHabRequest } from "./hab-cli.js";
import { redactSensitiveText } from "./supervisor-operations.js";

export function prepareReadOnlyHabRequest(input = {}) {
  if (Object.keys(input).some(key => !["args", "timeout_seconds"].includes(key))) throw new Error("Read-only HAB accepts only literal args and timeout_seconds.");
  const args = input.args;
  if (!Array.isArray(args) || args.length < 2 || args.length > 12 || args.some(value => typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error("Read-only HAB requires bounded literal args.");
  }
  const command = args.slice(0, 2).join(" ");
  if (!["dashboard list", "dashboard get", "helper list", "helper types"].includes(command)) {
    throw new Error("Command not in the reviewed HAB 1.7.2 read-only policy. Allowed: dashboard list/get, helper list/types.");
  }
  let index = 2;
  if (command === "dashboard get") {
    if (args.length !== 3 || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(args[index])) throw new Error("dashboard get requires one literal dashboard URL path.");
    index++;
  } else if (command === "helper list" && args[index] && !args[index].startsWith("-")) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(args[index])) throw new Error("Invalid helper type filter.");
    index++;
  }
  const seen = new Set();
  while (index < args.length) {
    const flag = args[index++];
    if (!["dashboard list", "helper list"].includes(command) || seen.has(flag)) throw new Error("Unexpected read-only HAB argument.");
    seen.add(flag);
    if (flag === "--brief" || flag === "--count") continue;
    if (flag === "--limit" && /^[1-9][0-9]{0,3}$/.test(args[index] ?? "") && Number(args[index]) <= 5000) { index++; continue; }
    throw new Error("Unreviewed read-only HAB flag. Allowed list flags: --brief, --count, --limit 1..5000.");
  }
  return prepareHabRequest({ args, timeout_seconds: input.timeout_seconds ?? 30 });
}

export function redactReadOnlyHabOutput(stdout, secrets = []) {
  function clean(value, depth = 0) {
    if (depth > 64) return "<depth limit>";
    if (typeof value === "string") {
      for (const secret of secrets) if (typeof secret === "string" && secret.length) value = value.split(secret).join("<redacted>");
      return redactSensitiveText(value).text;
    }
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|private[_-]?key)/i.test(key) ? "<redacted>" : clean(item, depth + 1)]));
    return value;
  }
  try { return JSON.stringify(clean(JSON.parse(String(stdout)))); }
  catch { return "Read-only HAB output withheld: expected a structured JSON result. Inspect the operation locally."; }
}
