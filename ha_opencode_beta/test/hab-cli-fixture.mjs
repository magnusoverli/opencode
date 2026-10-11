// Native image contract: real hab + real MCP dispatch, loopback HA fixtures only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCancellableExecFile } from "/opt/ha-mcp-server/lib/cancellation.js";
import { HAB_MAX_OUTPUT_BYTES } from "/opt/ha-mcp-server/lib/hab-cli.js";

const require = createRequire("/opt/ha-mcp-server/package.json");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { WebSocketServer } = require("ws");
const rawSchema = await runCancellableExecFile("/usr/local/bin/hab", ["schema", "--json"], {
  timeoutMs: 30000, maxBuffer: HAB_MAX_OUTPUT_BYTES,
});
const schema = JSON.parse(rawSchema).data;

// Validate the shipped argv examples against the actual pinned command tree,
// without executing their mutations. This catches nonexistent commands/flags.
const instructions = await readFile("/opt/ha-mcp-server/INSTRUCTIONS.md", "utf8");
let examples = 0;
for (const match of instructions.matchAll(/^hab_run\(args=(\[.*\])\)$/gm)) {
  const args = JSON.parse(match[1]);
  let node = schema, i = 0;
  for (; i < args.length; i++) {
    const next = node.subcommands?.find((entry) => entry.path.split(" ").at(-1) === args[i] || entry.aliases?.includes(args[i]));
    if (!next) break;
    node = next;
  }
  assert.notEqual(node, schema, `Unknown command in example: ${args[0]}`);
  if (node.subcommands?.length && !["hab guide", "hab schema"].includes(node.path)) {
    assert.equal(i, args.length, `Unknown subcommand in example: ${args.join(" ")}`);
  }
  const flags = [...(node.flags || []), ...(node.inherited_flags || [])];
  for (; i < args.length; i++) {
    if (!args[i].startsWith("-")) continue;
    const key = args[i].replace(/^--?/, "").split("=")[0];
    const flag = flags.find((entry) => entry.name === key || entry.shorthand === key);
    assert.ok(flag, `Unknown flag ${key} for ${node.path}`);
    if (flag.type !== "bool" && !args[i].includes("=")) i++;
  }
  examples++;
}
assert.ok(examples >= 20);

const token = "hab-native-fixture-token";
const violations = [];
const template = `{{ states('sensor.alice_s_room') }} "quoted"`;
let rendered = false, responseRequested = false;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) violations.push("Missing authenticated request");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (req.url === "/core/api/template") {
    if (body.template === "fixture-error") return res.writeHead(400).end('{"message":"Fixture rejected template"}');
    assert.equal(body.template, template);
    rendered = true;
    return res.writeHead(200).end("fixture template result");
  }
  if (req.url?.startsWith("/core/api/services/weather/get_forecasts")) {
    responseRequested = new URL(req.url, "http://fixture").searchParams.has("return_response");
    assert.equal(body.type, "daily");
    assert.equal(body.return_response, undefined);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ changed_states: [], service_response: { "weather.home": { forecast: [{ condition: "sunny" }] } } }));
  }
  violations.push(`Unexpected HTTP route ${req.method} ${req.url}`);
  res.writeHead(404).end();
});
const dashboard = { views: [{ title: "Retain every card", cards: Array.from({ length: 4000 }, (_, i) => ({ type: "markdown", content: `${i}: ${"x".repeat(350)}` })) }] };
const initialPatchDashboard = { title: "Keep dashboard", views: [{ title: "Keep view", cards: [
  { type: "tile", entity: "light.fixture", name: "Before", icon: "mdi:lightbulb", options: { keep: true } },
  { type: "markdown", content: "Untouched sibling" },
] }] };
let patchDashboard = structuredClone(initialPatchDashboard), saves = 0, saveMode = "normal";
const websocket = new WebSocketServer({ server });
websocket.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.0" }));
  let authenticated = false;
  socket.on("message", (message) => {
    const data = JSON.parse(message);
    if (data.type === "auth") {
      authenticated = data.access_token === token;
      if (!authenticated) violations.push("Invalid WS authentication");
      socket.send(JSON.stringify({ type: authenticated ? "auth_ok" : "auth_invalid" }));
      return;
    }
    if (!authenticated) violations.push("Unauthenticated WS command");
    if (data.url_path === "patch-fixture") {
      if (data.type === "lovelace/config") {
        socket.send(JSON.stringify({ id: data.id, type: "result", success: true, result: patchDashboard }));
        return;
      }
      if (data.type === "lovelace/config/save") {
        saves++;
        if (saveMode === "reject") {
          socket.send(JSON.stringify({ id: data.id, type: "result", success: false, error: { code: "permission_denied", message: "Fixture rejection" } }));
          return;
        }
        patchDashboard = data.config;
        if (saveMode === "lost-ack") { socket.close(); return; }
        socket.send(JSON.stringify({ id: data.id, type: "result", success: true, result: null }));
        return;
      }
    }
    if (data.type !== "lovelace/config" || data.url_path !== "fixture") violations.push(`Unexpected WS command ${data.type}`);
    socket.send(JSON.stringify({ id: data.id, type: "result", success: true, result: dashboard }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const home = await mkdtemp(join(tmpdir(), "hab-native-"));
const ownsRuntime = !existsSync("/run/opencode-v2");
await mkdir("/run/opencode-v2/workspace", { recursive: true, mode: 0o700 });
const client = new Client({ name: "hab-native-fixture", version: "1" });
const artifacts = [];
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["/opt/ha-mcp-server/index.js"],
    cwd: home, stderr: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home,
      SUPERVISOR_TOKEN: token, SUPERVISOR_BASE_URL: `http://127.0.0.1:${server.address().port}`, OPENCODE_MCP_TOOL_PROFILE: "full" } }));
  const call = async (args, expectError = false) => {
    const result = await client.callTool({ name: "hab_run", arguments: Array.isArray(args) ? { args } : args }, undefined, { signal: AbortSignal.timeout(30000) });
    assert.equal(Boolean(result.isError), expectError, result.content[0].text.replaceAll(token, "[redacted]"));
    assert.ok(!result.content[0].text.includes(token), "Fixture credential in result");
    return result;
  };
  const payload = (result) => JSON.parse(result.content[0].text);
  const version = payload(await call(["version"]));
  assert.equal(version.data.data.version, "1.7.2");
  const root = await call(["schema"]);
  assert.ok(root.content[0].text.length < 15000);
  assert.equal(payload(root).data.metadata.compact_schema, true);
  assert.ok(payload(root).data.data.subcommands.includes("hab marketplace"));
  assert.equal(payload(root).data.data.schema_version, "hab.command.v1.1");
  assert.ok(payload(root).data.data.schema_id.startsWith("sha256:"));
  const card = payload(await call(["schema", "dashboard", "card", "update"]));
  assert.ok(card.data.data.flags.some((flag) => flag.name === "section"));
  assert.equal(card.meta.truncated, false);
  const patchSchema = payload(await call(["schema", "dashboard", "patch", "--compact"])).data.data;
  assert.equal(patchSchema.payload_schema.type, "object");
  assert.ok(patchSchema.output_contract.variants.length > 0);
  const search = payload(await call(["schema", "--index", "--search", "dashboard patch", "--limit", "1"])).data.data;
  assert.equal(search.commands[0].path, "hab dashboard patch");
  assert.equal(search.complete, true);
  const page = payload(await call(["schema", "--index", "--limit", "1"])).data.data;
  assert.equal(page.complete, false);
  assert.equal(page.next_offset, 1);
  const nextPage = payload(await call(["schema", "--index", "--limit", "1", "--offset", String(page.next_offset)])).data.data;
  assert.equal(nextPage.offset, 1);
  assert.notEqual(nextPage.commands[0].path, page.commands[0].path);
  await call(["schema", "device", "typo"], true);
  const guides = payload(await call(["guide", "list"]));
  assert.equal(guides.data.metadata.compact_guide_index, true);
  assert.ok(guides.data.data.some((entry) => entry.id === "dashboard"));
  await call(["--json", "auth", "login"], true);
  await call({ command: '"update" --force' }, true);
  await call({ command: "version", args: ["version"] }, true);
  await call({ command: "version --json" });
  await call(["--json", "esphome", "--help"]);
  await call(["template", "render", template]);
  assert.equal(rendered, true);
  const failed = payload(await call(["template", "render", "fixture-error"], true));
  assert.equal(failed.data.success, false);
  assert.ok(failed.data.error.code);
  await call(["action", "call", "weather.get_forecasts", "--entity", "weather.home", "--data", '{"type":"daily"}', "--return-response"]);
  assert.equal(responseRequested, true);
  const large = payload(await call(["dashboard", "get", "fixture"]));
  assert.equal(large.meta.truncated, true);
  artifacts.push(dirname(large.meta.full_output_path));
  const complete = JSON.parse(await readFile(large.meta.full_output_path, "utf8"));
  assert.equal(complete.success, true);
  assert.deepEqual(complete.data, dashboard);
  const patchArgs = ["dashboard", "patch", "patch-fixture", "--target", "/views/0/cards/0", "--data", '{"name":"After"}'];
  const plan = payload(await call([...patchArgs, "--plan"])).data.data;
  assert.equal(plan.status, "planned");
  assert.equal(plan.would_change, true);
  assert.equal(plan.saved, false);
  assert.equal(plan.change_count, 1);
  assert.equal(plan.diff_complete, true);
  assert.equal(saves, 0);
  const applied = payload(await call([...patchArgs, "--if-match", plan.base_revision])).data.data;
  assert.equal(applied.status, "verified");
  assert.equal(applied.saved, true);
  assert.equal(applied.verified, true);
  assert.equal(applied.reloaded, "not_applicable");
  assert.equal(saves, 1);
  const expected = structuredClone(initialPatchDashboard);
  expected.views[0].cards[0].name = "After";
  assert.deepEqual(patchDashboard, expected);
  const noop = payload(await call([...patchArgs, "--if-match", applied.result_revision])).data.data;
  assert.equal(noop.status, "noop");
  assert.equal(noop.saved, false);
  assert.equal(saves, 1);
  const conflict = payload(await call([...patchArgs, "--if-match", plan.base_revision], true)).data.error;
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.details.result.saved, false);
  assert.equal(saves, 1);
  const furtherPatch = ["dashboard", "patch", "patch-fixture", "--target", "/views/0/cards/0", "--set", '/name="Final"'];
  const furtherPlan = payload(await call([...furtherPatch, "--plan"])).data.data;
  saveMode = "reject";
  const rejected = payload(await call([...furtherPatch, "--if-match", furtherPlan.base_revision], true)).data.error;
  assert.equal(rejected.code, "SAVE_REJECTED");
  assert.equal(rejected.details.result.saved, false);
  assert.equal(saves, 2);
  assert.deepEqual(patchDashboard, expected);
  saveMode = "lost-ack";
  const uncertain = payload(await call([...furtherPatch, "--if-match", furtherPlan.base_revision, "--timeout", "2s"], true)).data.error;
  assert.equal(uncertain.code, "VERIFICATION_UNAVAILABLE");
  assert.equal(uncertain.details.result.saved, null);
  assert.equal(uncertain.details.result.verified, false);
  assert.equal(uncertain.details.retryable, false);
  assert.equal(saves, 3, "Uncertain writes must never be automatically retried");
  assert.equal(patchDashboard.views[0].cards[0].name, "Final", "Lost acknowledgement does not mean unapplied");
  assert.deepEqual(violations, []);
  console.log(`PASS hab ${version.data.data.version}: ${examples} documented examples, native compact/searchable contracts, MCP dispatch and dashboard patch safety.`);
} finally {
  await client.close();
  for (const socket of websocket.clients) socket.terminate();
  await new Promise((resolve) => websocket.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const artifact of artifacts) await rm(artifact, { recursive: true, force: true });
  if (ownsRuntime) await rm("/run/opencode-v2", { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
