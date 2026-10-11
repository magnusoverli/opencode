import { createCommandOutputContent } from "./command-output.js";

// Full recursive schemas can exceed 7 MB. Bound subprocess memory
// independently from the much smaller model-facing preview/artifact threshold.
export const HAB_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Legacy command strings support quoting, not shell evaluation or pipelines. */
export function splitHabCommand(command) {
  const args = [];
  let token = "", quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
    } else if (char === "\\") {
      if (i + 1 === command.length) throw new Error("Unfinished escape in hab command; prefer args.");
      const next = command[i + 1];
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) token += char;
      else { i++; if (next !== "\n") token += next; }
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { args.push(token); token = ""; started = false; }
    } else {
      if (/[|;&<>`]/.test(char) || (char === "$" && command[i + 1] === "(")) {
        throw new Error("hab_run accepts one command, without shell operators; prefer args.");
      }
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in hab command; prefer args.");
  if (started) args.push(token);
  return args;
}

export function prepareHabRequest({ command, args, timeout_seconds = 60 } = {}) {
  if ((command !== undefined) === (args !== undefined)) {
    throw new Error("Provide exactly one of args (preferred) or command for hab_run.");
  }
  if (command !== undefined && (typeof command !== "string" || command.length > 262144)) {
    throw new Error("hab command must be a string of at most 262144 characters.");
  }
  const values = args === undefined ? splitHabCommand(command) : args;
  if (!Array.isArray(values) || !values.length || values.length > 256 ||
      values.some((value) => typeof value !== "string" || value.includes("\0")) ||
      values.reduce((size, value) => size + value.length, 0) > 262144) {
    throw new Error("hab args must contain 1–256 strings without NUL bytes, at most 262144 characters total.");
  }
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 120) {
    throw new Error("timeout_seconds must be an integer between 1 and 120.");
  }

  // Resolve the actual command after global flags, before enforcing app-owned
  // auth/update policy. String-prefix checks can be bypassed by '--json auth'.
  let index = 0;
  while (index < values.length && values[index].startsWith("-")) {
    const flag = values[index++];
    if (flag === "--config") {
      if (index === values.length) throw new Error("--config requires a value.");
      index++;
    } else if (flag === "--") {
      break;
    } else if (!/^--(?:config=.+|(?:json|text|verbose|skip-update-check|help)(?:=(?:true|false))?)$/.test(flag) && flag !== "-h") {
      throw new Error("Unknown leading hab flag; inspect help or use a command path first.");
    }
  }
  const root = values[index] || "help";
  if (root === "hab" || root.includes("/")) throw new Error("Pass hab arguments without an executable prefix.");
  if (root === "auth") throw new Error("Auth commands are not needed: hab uses the app's Supervisor credentials.");
  if (root === "update") throw new Error("Self-update of hab is not supported: update the app to update hab.");

  let schemaDepth;
  if (root === "schema") {
    const target = [];
    for (let i = index + 1; i < values.length; i++) {
      if (["--config", "--search", "--limit", "--offset"].includes(values[i])) { i++; continue; }
      if (values[i].startsWith("-") && values[i] !== "--") continue;
      if (values[i] !== "--") target.push(values[i]);
    }
    if (target[0] === "hab") target.shift();
    schemaDepth = target.length;
  }

  const argv = [...values];
  // Native compact discovery avoids generating the full recursive schema and
  // retains upstream payload/output contracts. Honour explicit discovery modes.
  if (root === "schema" && !values.some((value) => /^--(?:compact|index)(?:=|$)/.test(value))) {
    argv.splice(index + 1, 0, "--compact");
  }
  if (!values.some((value) => /^--(?:json|text)(?:=|$)/.test(value))) argv.unshift("--json");
  argv.unshift("--skip-update-check");
  return { argv, root, schemaDepth, timeoutMs: timeout_seconds * 1000 };
}

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));

/** Compact schema is navigation, not an authorization policy or live probe. */
export function compactHabDiscovery(envelope) {
  if (envelope?.success !== true) return envelope;
  if (envelope.operation === "schema" && envelope.data?.path) {
    const node = envelope.data;
    if (node.schema_id && node.envelope_ref) {
      // Native compact schemas have string child paths, versioned contracts and
      // a content hash. Keep the complete data intact, including that hash.
      return { ...envelope, metadata: { ...envelope.metadata, compact_schema: true } };
    }
    const data = pick(node, ["path", "use", "summary", "aliases", "args", "flag_constraints", "output_mode", "capabilities", "guide_topic"]);
    for (const key of ["flags", "inherited_flags"]) {
      if (node[key]) data[key] = node[key].filter((flag) => !flag.hidden);
    }
    data.subcommands = (node.subcommands || []).map((child) => pick(child, ["path", "use", "summary", "aliases"]));
    data.upstream_side_effect = node.side_effect;
    data.contract_notes = [
      "This is a compact command index/schema. Request schema for a child path for its arguments and flags.",
      "Upstream side-effect/capability annotations are advisory, not permission checks. Inspect the operation.",
      "--plan may be a static execution preview, not a live diff or full HA validation. Read back after applying.",
      "JSON results carry success, data, error, partial_result, warnings, missing_sections and verification_commands. Streams use NDJSON.",
    ];
    return { ...envelope, data, metadata: { ...envelope.metadata, compact_schema: true } };
  }
  if (envelope.resource_type === "guide" && envelope.operation === "list" && Array.isArray(envelope.data)) {
    return { ...envelope, data: envelope.data.map((topic) => pick(topic, ["id", "title", "summary", "aliases"])),
      metadata: { ...envelope.metadata, compact_guide_index: true } };
  }
  return envelope;
}

export function formatHabExecution(request, stdout, error, options = {}) {
  let parsed;
  try { parsed = JSON.parse(String(stdout)); } catch { /* Help/text/stream output. */ }
  const processFailed = Boolean(error);
  // Never describe a killed or output-limited process as a completed mutation,
  // even if its retained stdout happens to contain a complete success envelope.
  if (processFailed && parsed?.success === false && typeof error.code === "number") {
    parsed = { ...parsed, metadata: { ...parsed.metadata, exit_code: error.code } };
  } else if (processFailed) {
    parsed = {
      success: false,
      error: { code: String(error.code || error.name || "PROCESS_FAILED"),
        message: "hab did not complete successfully. Inspect current state before retrying a mutation." },
      partial_result: true,
      data: { result: parsed ?? null, output: parsed ? undefined : String(stdout || error.stderr || "") },
      metadata: { process_failed: true, outcome_unverified: true },
    };
  } else if (request.root === "schema" || request.root === "guide") {
    // Upstream 1.7.1 can silently return a parent schema for an unknown suffix.
    // Surface that as an error rather than teaching the agent a nonexistent API.
    if (request.root === "schema" && parsed?.success === true && parsed.data?.path &&
        parsed.data.path.split(" ").length - 1 !== request.schemaDepth) {
      parsed = { success: false, error: { code: "UNKNOWN_COMMAND_PATH",
        message: "No exact hab schema matched. Inspect the parent command's subcommands." },
        data: { matched_path: parsed.data.path } };
    }
    parsed = compactHabDiscovery(parsed);
  }
  const output = parsed === undefined ? stdout : JSON.stringify(parsed);
  // Only the command family is echoed; payloads and credential-bearing flags
  // must not be duplicated into metadata or logs.
  return {
    ...(processFailed || parsed?.success === false ? { isError: true } : {}),
    content: [createCommandOutputContent("hab", request.root, output, options)],
  };
}
