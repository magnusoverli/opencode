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
const deviceId = "12345678aaaaaaaaaaaaaaaaaaaaaaaa";
const otherDeviceId = "12345678bbbbbbbbbbbbbbbbbbbbbbbb";
const labelId = "abcdef0123456789abcdef0123456789";
const categoryId = "facefeedaaaaaaaaaaaaaaaaaaaaaaaa";
const registries = {
  entity: [{ entity_id: "light.fixture", unique_id: "fixture-integration-id", device_id: deviceId,
    name: "Original", icon: "mdi:lightbulb", device_class: null, area_id: null, labels: [],
    aliases: ["Original alias"], categories: { automation: "keep_category" }, hidden_by: "user", disabled_by: "user" }],
  device: [deviceId, otherDeviceId].map((id) => ({ id, name: "Integration name", name_by_user: "Original device", area_id: "kitchen", labels: [], disabled_by: "user" })),
  area: [{ area_id: "kitchen", name: "Kitchen", floor_id: "ground", icon: "mdi:countertop", aliases: [], labels: [], picture: null, temperature_entity_id: null, humidity_entity_id: null },
    { area_id: "office", name: "Office", floor_id: "ground", icon: null, aliases: [], labels: [], picture: null, temperature_entity_id: null, humidity_entity_id: null }],
  floor: [{ floor_id: "ground", name: "Ground floor", aliases: [], icon: "mdi:home", level: 0 }],
  label: [{ label_id: labelId, name: "Lighting", icon: "mdi:lamp", color: "red", description: "Original label" }],
};
const states = () => [
  { entity_id: registries.entity[0].entity_id, state: "off", attributes: {}, last_changed: "2026-10-26T00:00:00Z" },
  { entity_id: "light.collision", state: "off", attributes: {} },
  { entity_id: "sensor.temperature", state: "20", attributes: { device_class: "temperature" } },
  { entity_id: "sensor.humidity", state: "40", attributes: { device_class: "humidity" } },
];
let registryWrites = 0, registrySaveMode = "normal", registryReadFailure = false, typedAction, holdStateRead;
let rendered = false, responseRequested = false;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) violations.push("Missing authenticated request");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (req.url === "/core/api/states") {
    const snapshot = states();
    const complete = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(snapshot));
    if (holdStateRead) {
      const hold = holdStateRead;
      holdStateRead = null;
      hold(complete);
      return;
    }
    return complete();
  }
  if (req.url === "/core/api/states/automation.fixture") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ entity_id: "automation.fixture", state: "on", attributes: { id: "fixture-config-id" } }));
  }
  if (req.url === "/core/api/services/light/turn_on") {
    typedAction = body;
    return res.writeHead(200, { "content-type": "application/json" }).end("[]");
  }
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
    const reply = (result) => socket.send(JSON.stringify({ id: data.id, type: "result", success: true, result }));
    const reject = () => socket.send(JSON.stringify({ id: data.id, type: "result", success: false, error: { code: "fixture_rejection", message: "Synthetic registry failure" } }));
    if (data.type === "get_states") return reply(states());
    if (data.type === "search/related") return reply({ automation: ["automation.fixture"] });
    if (data.type === "trace/list") {
      assert.equal(data.item_id, "fixture-config-id", "Trace requests must use the config ID, not the entity object ID");
      assert.equal(data.domain, "automation");
      return reply([{ run_id: "87654321aaaaaaaaaaaaaaaaaaaaaaaa" }]);
    }
    if (data.type === "config/category_registry/list") {
      return reply([{ category_id: data.scope === "helpers" ? categoryId : "facefeedbbbbbbbbbbbbbbbbbbbbbbbb", name: "Scoped category" }]);
    }
    const registryCommand = /^config\/(entity|device|area|floor|label)_registry\/(list|get|update)$/.exec(data.type);
    if (registryCommand) {
      const [, kind, operation] = registryCommand;
      if (operation !== "update" && registryReadFailure) return reject();
      if (operation === "list") return reply(registries[kind]);
      const key = kind === "device" ? "id" : `${kind}_id`;
      const selector = kind === "device" ? data.device_id : data[key];
      const record = registries[kind].find((entry) => entry[key] === selector);
      if (!record) return reject();
      if (operation === "get") return reply(record);
      registryWrites++;
      if (registrySaveMode === "reject") return reject();
      if (registrySaveMode !== "mismatch") {
        for (const [field, value] of Object.entries(data)) {
          if (["id", "type", "device_id", key].includes(field)) continue;
          if (field === "new_entity_id") record.entity_id = value;
          else if (field === "categories") {
            for (const [scope, category] of Object.entries(value)) {
              if (category === null) delete record.categories[scope];
              else record.categories[scope] = category;
            }
          } else record[field] = value;
        }
      }
      if (registrySaveMode === "lost-ack") { socket.close(); return; }
      if (registrySaveMode === "readback-fail") registryReadFailure = true;
      return reply(kind === "entity" ? { entity_entry: record, require_restart: true } : record);
    }
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
       SUPERVISOR_TOKEN: token, SUPERVISOR_BASE_URL: `http://127.0.0.1:${server.address().port}`,
       HA_API_BASE_URL: `http://127.0.0.1:${server.address().port}/core/api`, OPENCODE_MCP_TOOL_PROFILE: "full" } }));
  const call = async (args, expectError = false) => {
    const result = await client.callTool({ name: "hab_run", arguments: Array.isArray(args) ? { args } : args }, undefined, { signal: AbortSignal.timeout(30000) });
    assert.equal(Boolean(result.isError), expectError, result.content[0].text.replaceAll(token, "[redacted]"));
    assert.ok(!result.content[0].text.includes(token), "Fixture credential in result");
    return result;
  };
  const payload = (result) => JSON.parse(result.content[0].text);
  const version = payload(await call(["version"]));
  assert.equal(version.data.data.version, "1.8.0");
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

    // Registry updates: exact native contracts, live previews, literal clearing,
    // explicit false, scoped references, preserved unique_id and unrelated data.
    for (const resource of ["entity", "device", "area", "floor", "label"]) {
      const contract = payload(await call(["schema", resource, "update"])).data.data;
      // Upstream still labels these as command_plan; prove their live reads
      // below rather than treating discovery annotations as runtime evidence.
      assert.ok(contract.flags.some((flag) => flag.name === "plan"));
      assert.ok(contract.output_contract.variants.some((variant) => variant.data.fields.some((field) => field.name === "saved")));
    }
    const deviceSchema = payload(await call(["schema", "device", "update"])).data.data;
    assert.ok(deviceSchema.short_id_inputs.some((input) => input.resource === "device" && input.minimum_length === 8));
    const discovered = payload(await call(["id", "list", "device"])).data.data;
    // The dedicated ID catalog is authoritative even when the filtered list is small.
    const catalog = Array.isArray(discovered) ? discovered : discovered.items;
    const shortDevice = catalog.find((entry) => entry.id === deviceId).short_id;
    assert.ok(shortDevice.length > 8, "Shared eight-character prefixes must be lengthened");
    const filtered = payload(await call(["device", "list", "--limit", "1", "--brief"])).data.data;
    assert.equal(filtered[0].id, deviceId);
    assert.equal(filtered[0].short_id, shortDevice);
    const ambiguous = payload(await call(["device", "update", "12345678", "--name", "Wrong device"], true)).data.error;
    assert.equal(ambiguous.code, "ID_RESOLUTION_FAILED");
    assert.equal(ambiguous.details.candidates.length, 2);
    await call(["device", "update", "12345678", "--name", "Wrong device", "--plan"], true);
    assert.equal(registryWrites, 0);

    const initialEntity = structuredClone(registries.entity[0]);
    const entityArgs = ["entity", "update", "light.fixture", "--name", "Kitchen light", "--icon", "", "--area", "office",
      "--labels", labelId.slice(0, 8), "--aliases", "Kitchen light,Counter light", "--category", "helpers=facefeed", "--hidden=false", "--disabled=false"];
    const entityPlan = payload(await call([...entityArgs, "--plan"])).data.data;
    assert.equal(entityPlan.mode, "plan");
    assert.equal(entityPlan.saved, false);
    assert.equal(entityPlan.verified, false);
    assert.deepEqual(entityPlan.changes.icon, { before: "mdi:lightbulb", after: null });
    assert.equal(entityPlan.changes.categories.after.helpers, categoryId);
    assert.equal(entityPlan.changes.categories.after.automation, "keep_category");
    assert.equal(registryWrites, 0);
    assert.deepEqual(registries.entity[0], initialEntity);
    const entityApplied = payload(await call(entityArgs)).data;
    assert.equal(entityApplied.data.saved, true);
    assert.equal(entityApplied.data.verified, true);
    assert.equal(entityApplied.data.unique_id, initialEntity.unique_id);
    assert.ok(entityApplied.data.warnings.some((warning) => /restart/i.test(warning)));
    assert.ok(entityApplied.metadata.resolved_ids.some((entry) => entry.id === categoryId));
    assert.deepEqual(registries.entity[0], { ...initialEntity, name: "Kitchen light", icon: null, area_id: "office", labels: [labelId],
      aliases: ["Kitchen light", "Counter light"], categories: { automation: "keep_category", helpers: categoryId }, hidden_by: null, disabled_by: null });
    await call(["entity", "update", "light.fixture", "--name", "", "--area", "", "--labels", "", "--aliases", "", "--category", "helpers="]);
    assert.equal(registries.entity[0].name, null);
    assert.equal(registries.entity[0].area_id, null);
    assert.deepEqual(registries.entity[0].aliases, []);
    assert.deepEqual(registries.entity[0].labels, []);
    assert.deepEqual(registries.entity[0].categories, { automation: "keep_category" });
    const beforeInvalid = registryWrites;
    await call(["entity", "update", "light.fixture", "--labels", "not_a_label", "--plan"], true);
    await call(["entity", "update", "light.fixture", "--entity-id", "switch.fixture", "--plan"], true);
    await call(["entity", "update", "light.fixture", "--entity-id", "light.collision", "--plan"], true);
    const rename = payload(await call(["entity", "update", "light.fixture", "--entity-id", "light.renamed", "--plan"])).data.data;
    assert.deepEqual(rename.related.automation, ["automation.fixture"]);
    assert.ok(rename.warnings.some((warning) => /does not rewrite/.test(warning)));
    assert.equal(registryWrites, beforeInvalid);

    // Caches are primed in the same MCP process before every operation. Later
    // context reads must see new metadata even after an unverified CLI outcome.
    const context = async (entity_id = "light.fixture") => {
      const result = await client.callTool({ name: "get_home_context", arguments: { entity_id } });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text).data.entities[0];
    };
    assert.equal((await context()).device, "Original device");
    const deviceArgs = ["device", "update", shortDevice, "--name", "Kitchen plug", "--area", "office", "--labels", labelId.slice(0, 8), "--disabled=false"];
    const beforeDevice = registryWrites;
    const devicePlan = payload(await call([...deviceArgs, "--plan"])).data.data;
    assert.equal(devicePlan.would_change, true);
    assert.equal(devicePlan.saved, false);
    assert.equal(registryWrites, beforeDevice);
    const deviceApplied = payload(await call(deviceArgs)).data;
    assert.equal(deviceApplied.data.saved, true);
    assert.equal(deviceApplied.data.verified, true);
    assert.ok(deviceApplied.metadata.resolved_ids.some((entry) => entry.input === shortDevice && entry.id === deviceId));
    assert.equal((await context()).device, "Kitchen plug");
    assert.equal((await context()).area, "Office");
    const deviceNoop = payload(await call(deviceArgs)).data.data;
    assert.equal(deviceNoop.would_change, false);
    assert.equal(deviceNoop.saved, false);
    assert.equal(deviceNoop.verified, true);
    assert.equal(registryWrites, beforeDevice + 1);
    await call(["device", "update", deviceId, "--name", "", "--area", "", "--labels", ""]);
    assert.equal(registries.device[0].name_by_user, null);
    assert.equal(registries.device[0].area_id, null);
    assert.deepEqual(registries.device[0].labels, []);

    for (const args of [
      ["area", "update", "kitchen", "--aliases", "Kitchen,Cooking area", "--labels", labelId, "--picture", "/local/kitchen.jpg", "--temperature-entity", "sensor.temperature", "--humidity-entity", "sensor.humidity"],
      ["floor", "update", "ground", "--aliases", "Downstairs,Ground floor", "--level", ""],
      ["label", "update", labelId, "--icon", "", "--color", "", "--description", ""],
    ]) {
      const before = registryWrites;
      const preview = payload(await call([...args, "--plan"])).data.data;
      assert.equal(preview.mode, "plan");
      assert.equal(preview.saved, false);
      assert.equal(registryWrites, before);
      const result = payload(await call(args)).data.data;
      assert.equal(result.saved, true);
      assert.equal(result.verified, true);
      const unchanged = payload(await call(args)).data.data;
      assert.equal(unchanged.saved, false);
      assert.equal(unchanged.verified, true);
      assert.equal(registryWrites, before + 1);
    }
    assert.equal(registries.area[0].temperature_entity_id, "sensor.temperature");
    assert.equal(registries.floor[0].level, null);
    assert.equal(registries.label[0].description, null);
    await call(["area", "update", "kitchen", "--temperature-entity", "sensor.humidity", "--plan"], true);

    for (const mode of ["reject", "mismatch", "readback-fail", "lost-ack"]) {
      await context(); // Prime the cache before the attempted write.
      registrySaveMode = mode;
      const before = registryWrites;
      const failed = payload(await call({ args: ["device", "update", deviceId, "--name", `Outcome ${mode}`], timeout_seconds: 5 }, true)).data;
      registryReadFailure = false;
      registrySaveMode = "normal";
      assert.equal(registryWrites, before + 1, "Unverified writes must never be automatically retried");
      if (mode === "lost-ack") {
        // hab can wait longer than the gateway after a lost socket. Killing it
        // must report uncertainty, even though the fixture accepted the write.
        assert.equal(failed.error.code, "TimeoutError");
        assert.equal(failed.metadata.outcome_unverified, true);
      } else {
        assert.equal(failed.error.code, "REGISTRY_UPDATE_FAILED", mode);
        assert.equal(failed.error.details.retryable, false);
        assert.equal(failed.error.details.result.saved, mode === "reject" ? null : true);
        assert.equal(failed.error.details.result.verified, false);
      }
      assert.equal((await context()).device, registries.device[0].name_by_user || registries.device[0].name);
    }

    await call(["action", "call", "light.turn_on", "--data", JSON.stringify({ device_id: shortDevice, variables: { device_id: shortDevice }, note: shortDevice })]);
    assert.equal(typedAction.device_id, deviceId);
    assert.equal(typedAction.variables.device_id, shortDevice);
    assert.equal(typedAction.note, shortDevice);
    const traces = payload(await call(["automation", "trace", "automation.fixture"])).data.data;
    assert.equal(traces[0].run_id, "87654321aaaaaaaaaaaaaaaaaaaaaaaa");
    await call(["device", "list", "--limit", "1"]); // Discard the last state snapshot.
    let releaseStateRead;
    const stateReadStarted = new Promise((resolve) => {
      holdStateRead = (complete) => { releaseStateRead = complete; resolve(); };
    });
    const oldContext = context();
    await stateReadStarted;
    try {
      const renamed = payload(await call(["entity", "update", "light.fixture", "--entity-id", "light.renamed"])).data.data;
      assert.equal(renamed.saved, true);
      assert.equal(renamed.verified, true);
      assert.equal(registries.entity[0].entity_id, "light.renamed");
      assert.equal(registries.entity[0].unique_id, initialEntity.unique_id);
      assert.equal(patchDashboard.views[0].cards[0].entity, "light.fixture", "Registry renames must not imply dashboard reference rewriting");
      assert.equal((await context("light.renamed"))?.entity_id, "light.renamed", "New reads must not join a pre-rename in-flight request");
    } finally {
      releaseStateRead();
      await oldContext;
    }
    assert.equal((await context("light.renamed"))?.entity_id, "light.renamed", "Post-rename context must not reuse the old state snapshot");
    assert.deepEqual(violations, []);
    console.log(`PASS hab ${version.data.data.version}: ${examples} documented examples, native compact/searchable contracts, real MCP argv/legacy dispatch, template quoting, action responses, full dashboard retention, dashboard patch safety, registry live plans/apply/clear/false/noop/rejection/mismatch/read-back failure/uncertain-save, short-ID collision/scopes/typed references, fresh MCP registry context and automation trace IDs; schema ${Buffer.byteLength(rawSchema)} bytes -> ${Buffer.byteLength(root.content[0].text)} bytes.`);
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
