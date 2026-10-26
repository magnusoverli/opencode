import assert from "node:assert/strict";
import { test } from "vitest";
import { prepareHabRequest, splitHabCommand, formatHabExecution, withHabRegistryInvalidation } from "../lib/hab-cli.js";
import { createRegistryCache } from "../lib/registry-cache.js";

const unwrap = (response) => JSON.parse(response.content[0].text);

test("literal argv preserves JSON, Jinja, apostrophes, spaces and empty values", () => {
  const args = ["event", "fire", "test_event", "--data", JSON.stringify({ text: `Alice's \"room\"`, template: "{{ states('sun.sun') }}", empty: "" })];
  assert.deepEqual(prepareHabRequest({ args }).argv, ["--skip-update-check", "--json", ...args]);
  assert.deepEqual(prepareHabRequest({ args: ["template", "render", ""] }).argv.slice(-1), [""]);
  assert.equal(prepareHabRequest({ args }).timeoutMs, 60000);
  assert.ok(!prepareHabRequest({ args: ["help", "--text"] }).argv.includes("--json"));
  const update = ["entity", "update", "light.kitchen", "--icon", "", "--hidden=false", "--disabled=false", "--labels", "", "--plan"];
  assert.deepEqual(prepareHabRequest({ args: update }).argv, ["--skip-update-check", "--json", ...update]);
});

test("legacy parsing handles adjacent/escaped quotes without interpreting a shell", () => {
  assert.deepEqual(splitHabCommand(`template render "{{ states('sun.sun') }}"`), ["template", "render", "{{ states('sun.sun') }}"]);
  assert.deepEqual(splitHabCommand(`person create 'Alice'"'"'s office'`), ["person", "create", "Alice's office"]);
  assert.deepEqual(splitHabCommand('event fire test --data \'{"text":"a \\\"quote\\\""}\''), ["event", "fire", "test", "--data", '{"text":"a \\"quote\\""}']);
  assert.deepEqual(splitHabCommand('template render ""'), ["template", "render", ""]);
  assert.deepEqual(splitHabCommand('template render "C:\\path"'), ["template", "render", "C:\\path"]);
  for (const command of ["version; update", "version | cat", "version > out", "$(echo update)", "`update`", "'unfinished", '"unfinished', "unfinished\\"]) {
    assert.throws(() => prepareHabRequest({ command }));
  }
});

test("managed auth/update policy is applied after tokenization and global flags", () => {
  for (const args of [["auth"], ["update", "--check"], ["--json", "auth", "login"], ["--config", "/tmp/fixture", "update"], ["--text=true", "--", "auth"], ["--verbose", "esphome", "list"]]) {
    if (args.includes("esphome")) assert.equal(prepareHabRequest({ args }).root, "esphome");
    else assert.throws(() => prepareHabRequest({ args }), /Auth commands|Self-update/);
  }
  assert.throws(() => prepareHabRequest({ command: '"update" --force' }), /Self-update/);
  assert.equal(prepareHabRequest({ args: ["schema", "auth", "login"] }).root, "schema");
  assert.equal(prepareHabRequest({ args: ["--help"] }).root, "help");
});

test("invalid inputs fail before subprocess execution", () => {
  for (const input of [{}, { args: [], command: "version" }, { args: [] }, { args: [1] }, { args: ["bad\0value"] }, { command: 1 }, { args: ["hab", "version"] }, { args: ["version"], timeout_seconds: 121 }, { args: ["version"], timeout_seconds: 0 }, { args: ["version"], timeout_seconds: 1.5 }]) {
    assert.throws(() => prepareHabRequest(input));
  }
});

test("compact discovery keeps the selected contract and immediate children only", () => {
  const request = prepareHabRequest({ args: ["schema", "dashboard"] });
  const envelope = { success: true, operation: "schema", data: { path: "hab dashboard", use: "dashboard", side_effect: "meta",
    flags: [{ name: "json", type: "bool" }], output_contract: { repeated: "x".repeat(100000) },
    subcommands: [{ path: "hab dashboard card", use: "card", summary: "Cards", subcommands: [{ path: "hab dashboard card get" }], output_contract: { repeated: "x".repeat(100000) } }] } };
  const result = unwrap(formatHabExecution(request, JSON.stringify(envelope)));
  assert.equal(result.data.data.path, "hab dashboard");
  assert.equal(result.data.metadata.compact_schema, true);
  assert.equal(result.data.data.output_contract, undefined);
  assert.equal(result.data.data.subcommands[0].subcommands, undefined);
  assert.deepEqual(result.data.data.flags, envelope.data.flags);
  assert.match(result.data.data.contract_notes.join(" "), /not permission checks/);
  assert.ok(JSON.stringify(result).length < 3000);

  const typo = formatHabExecution(prepareHabRequest({ args: ["schema", "device", "update"] }),
    JSON.stringify({ success: true, operation: "schema", data: { path: "hab device" } }));
  assert.equal(typo.isError, true);
  assert.equal(unwrap(typo).data.error.code, "UNKNOWN_COMMAND_PATH");
});

test("guide indexes are compact while selected guide recipes are retained", () => {
  const topic = { id: "dashboard", title: "Dashboard", summary: "Edit cards", recipes: [{ steps: ["read", "plan", "apply"] }] };
  const list = unwrap(formatHabExecution(prepareHabRequest({ args: ["guide", "list"] }),
    JSON.stringify({ success: true, resource_type: "guide", operation: "list", data: [topic] })));
  assert.equal(list.data.data[0].recipes, undefined);
  const get = unwrap(formatHabExecution(prepareHabRequest({ args: ["guide", "dashboard"] }),
    JSON.stringify({ success: true, resource_type: "guide", operation: "get", data: topic })));
  assert.deepEqual(get.data.data.recipes, topic.recipes);
});

test("native compact schemas retain payloads, output variants, string children and identity", () => {
  const args = ["schema", "dashboard", "patch"];
  const request = prepareHabRequest({ args });
  assert.deepEqual(request.argv, ["--skip-update-check", "--json", "schema", "--compact", "dashboard", "patch"]);
  const data = { path: "hab dashboard patch", schema_version: "hab.command.v1.1", cli_version: "1.8.0",
    schema_id: "sha256:fixture", envelope_ref: "hab.envelope.v1", transports: ["ws"], preview: "live_diff",
    payload_schema: { type: "object", open: true }, output_contract: { variants: [{ name: "full", data: { type: "object" } }] },
    subcommands: ["hab dashboard patch child"], input_sources: ["flags"], side_effect: "write",
    short_id_inputs: [{ flag: "device", resource: "device", minimum_length: 8, live_resolution: true }] };
  const result = unwrap(formatHabExecution(request, JSON.stringify({ success: true, operation: "schema", data })));
  assert.deepEqual(result.data.data, data);
  assert.equal(result.data.metadata.compact_schema, true);
});

test("searchable discovery preserves query arguments, page bounds and continuation", () => {
  const args = ["schema", "dashboard", "--index", "--search", "patch fields", "--limit", "1", "--offset", "0"];
  const request = prepareHabRequest({ args });
  assert.deepEqual(request.argv, ["--skip-update-check", "--json", ...args]);
  assert.equal(request.schemaDepth, 1);
  const data = { schema_version: "hab.command.v1.1", cli_version: "1.8.0", envelope_ref: "hab.envelope.v1",
    commands: [{ path: "hab dashboard patch", side_effect: "write" }], total: 2, offset: 0, complete: false, next_offset: 1 };
  const result = unwrap(formatHabExecution(request, JSON.stringify({ success: true, operation: "schema", data })));
  assert.deepEqual(result.data.data, data);
  assert.equal(prepareHabRequest({ args: ["schema", "--compact", "dashboard"] }).schemaDepth, 1);
  assert.ok(!prepareHabRequest({ args: ["schema", "--compact=false"] }).argv.includes("--compact"));
});

test("dashboard patch failures preserve save certainty and verification evidence", () => {
  const request = prepareHabRequest({ args: ["dashboard", "patch", "home", "--if-match", "sha256:fixture", "--data", '{"title":"New"}'] });
  for (const [code, saved] of [["CONFLICT", false], ["SAVE_REJECTED", false], ["VERIFICATION_UNAVAILABLE", null], ["VERIFICATION_MISMATCH", true]]) {
    const data = { success: false, error: { code, details: { retryable: false, result: { saved, verified: false } } } };
    const result = formatHabExecution(request, JSON.stringify(data), { code: 1 });
    assert.equal(result.isError, true);
    assert.deepEqual(unwrap(result).data.error, data.error);
  }
});

test("registry update evidence and short-ID expansion metadata pass through intact", () => {
  const request = prepareHabRequest({ args: ["device", "update", "12345678", "--disabled=false"] });
  const metadata = { resolved_ids: [{ resource: "device", scope: "", input: "12345678", id: "1234567890abcdef1234567890abcdef" }] };
  for (const saved of [false, true, null]) {
    const result = { mode: "apply", saved, verified: saved === true, changes: { disabled_by: { before: "user", after: null } } };
    const envelope = saved === null
      ? { success: false, error: { code: "REGISTRY_UPDATE_FAILED", details: { result, retryable: false } }, metadata }
      : { success: true, data: result, metadata };
    const formatted = formatHabExecution(request, JSON.stringify(envelope), saved === null ? { code: 1 } : undefined);
    const actual = unwrap(formatted).data;
    assert.deepEqual(actual.metadata, saved === null ? { ...metadata, exit_code: 1 } : metadata);
    assert.deepEqual(saved === null ? actual.error.details.result : actual.data, result);
    assert.equal(Boolean(formatted.isError), saved === null);
  }
});

for (const outcome of ["success", "rejected", "uncertain", "timeout", "cancelled", "output-limit"]) {
  test(`connected hab ${outcome} clears old and in-flight registry snapshots`, async () => {
    let value = "before", release, ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const cache = createRegistryCache(async () => value);
    assert.equal(await cache.get("devices"), "before");
    const operation = withHabRegistryInvalidation(
      prepareHabRequest({ args: ["--json", "device", "update", "fixture", "--name", "after"] }),
      () => cache.clear(),
      async () => {
        assert.equal(await cache.get("devices"), "before"); // Read during the CLI invocation.
        await new Promise((resolve) => { release = resolve; ready(); });
        if (outcome !== "rejected") value = "after";
        if (outcome !== "success") throw new Error(outcome);
        return "result";
      },
    );
    await started;
    release();
    if (outcome === "success") assert.equal(await operation, "result");
    else await assert.rejects(operation, new RegExp(outcome));
    assert.equal(await cache.get("devices"), value);
  });
}

test("local hab discovery does not invalidate registry caches; connected reads/previews are conservative", async () => {
  let invalidations = 0;
  for (const root of ["schema", "guide", "help", "version"]) {
    assert.equal(await withHabRegistryInvalidation({ root }, () => invalidations++, async () => root), root);
  }
  assert.equal(invalidations, 0);
  for (const args of [["device", "list"], ["area", "update", "kitchen", "--name", "Kitchen", "--plan"]]) {
    await withHabRegistryInvalidation(prepareHabRequest({ args }), () => invalidations++, async () => null);
  }
  assert.equal(invalidations, 4);
});

test("CLI failures, partial results and interrupted mutations keep honest outcomes", () => {
  const request = prepareHabRequest({ args: ["area", "create", "Kitchen"] });
  const failure = { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid input" } };
  for (const error of [undefined, { code: 1 }]) {
    const result = formatHabExecution(request, JSON.stringify(failure), error);
    assert.equal(result.isError, true);
    assert.match(unwrap(result).summary, /failed/);
    assert.equal(unwrap(result).data.error.code, "VALIDATION_ERROR");
  }
  const partial = unwrap(formatHabExecution(request, JSON.stringify({ success: true, partial_result: true, warnings: ["Reload not confirmed"] })));
  assert.match(partial.summary, /partial/);
  assert.deepEqual(partial.data.warnings, ["Reload not confirmed"]);
  for (const error of [{ name: "TimeoutError" }, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }]) {
    const result = formatHabExecution(request, '{"success":true,"data":{"id":"kitchen"}}', error);
    assert.equal(result.isError, true);
    assert.equal(unwrap(result).data.metadata.outcome_unverified, true);
    assert.equal(unwrap(result).data.data.result.data.id, "kitchen");
    assert.match(unwrap(result).summary, /failed/);
  }
});

test("large results preserve the complete envelope without echoing input payloads", () => {
  const request = prepareHabRequest({ args: ["dashboard", "save-config", "panel", "--data", "private-input"] });
  const data = { success: true, data: { views: [{ content: "x".repeat(40000) }] } };
  let saved;
  const result = unwrap(formatHabExecution(request, JSON.stringify(data), undefined, {
    saveLargeOutput: (value) => { saved = value; return "/runtime/full.json"; },
  }));
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.full_output_path, "/runtime/full.json");
  assert.equal(result.meta.command, "dashboard");
  assert.deepEqual(JSON.parse(saved), data);
  assert.ok(!JSON.stringify(result).includes("private-input"));
});
