import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentStore, encodeAgentFile, parseAgentFile } from "../rootfs/opt/opencode-v2-homeassistant/agents-store.js";
import { agentPolicy, constrainAgent, updateAgentConfig, validateAgentConfig, validateAgentId } from "../rootfs/opt/opencode-v2-homeassistant/agents-policy.js";
import { createAgentSettingsBridge } from "../rootfs/opt/opencode-v2-homeassistant/agent-settings.js";
import { buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

const permissions = buildManagedConfig().permissions;
const guards = agentPolicy(permissions);
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), "ha-user-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createAgentStore(root) };
};
const config = { description: "Dutch description — behouden", mode: "primary", system: "Investigate safely.", permissions: [{ action: "shell", resource: "*", effect: "deny" }] };

test("native Markdown round trips without evaluating substitutions; fields, names and aliases fail closed", () => {
  assert.deepEqual(parseAgentFile(encodeAgentFile(config)), config);
  for (const id of ["../escape", "/absolute", "a\\b", "a//b", "a/../b", "__proto__", "home-assistant-read-only", "title", "home-assistant-assist"]) assert.throws(() => validateAgentId(id));
  for (const bad of [{ plugins: [] }, { permission: {} }, { system: "{file:/run/opencode-v2/server-password}" },
    { description: "{env:SUPERVISOR_TOKEN}" }, { request: { body: JSON.parse('{"__proto__":{}}') } },
    { permissions: [{ action: "read", resource: "*", effect: "bad" }] }, { system: "x".repeat(65537) }]) assert.throws(() => validateAgentConfig(bad));
  for (const text of ["no frontmatter", "---\ndescription: one\ndescription: two\n---\n", "---\na: &x value\ndescription: *x\n---\n", "---\nsystem: hidden\n---\nbody", "---\ndescription: !!str tagged\n---\n", "---\nnull\n---\n", "---\n[]\n---\n"]) assert.throws(() => parseAgentFile(Buffer.from(text)));
  assert.throws(() => updateAgentConfig({}, { plugins: null }));
  assert.deepEqual(updateAgentConfig({ ...config, color: "#abcdef" }, { color: null }), config);
});

test("user denials stay ordered while broad allow rules cannot relax managed asks or sensitive reads", () => {
  const rules = constrainAgent({ permissions: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: "safe.yaml", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "git status*", effect: "allow" },
    { action: "shell", resource: "rm *", effect: "allow" },
  ] }, guards).permissions;
  assert.equal(rules[0].effect, "deny");
  assert.equal(rules[1].effect, "ask");
  assert.equal(rules[2].effect, "allow");
  assert.equal(rules[3].effect, "allow");
  assert.equal(rules[4].effect, "ask");
  assert.ok(rules.some(rule => rule.resource === "*secrets.yaml" && rule.effect === "deny"));
  assert.ok(!constrainAgent({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, guards).permissions.some(rule => rule.effect === "allow"));
  const once = constrainAgent(config, guards);
  assert.deepEqual(constrainAgent(once, guards), once, "private snapshot replay must not grow rules/revisions");
});

test("source traversal/count/total limits stop publication instead of importing a partial set", async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 65; i++) await store.replace(`agents/a${i}.md`, null, encodeAgentFile({}));
  await assert.rejects(store.scan(), /maximum 64/);
  for (let i = 0; i < 65; i++) await rm(join(store.root, `agents/a${i}.md`));
  for (let i = 0; i < 18; i++) await store.replace(`agents/a${i}.md`, null, encodeAgentFile({ system: "x".repeat(60000) }));
  await assert.rejects(store.scan(), /1 MiB/);
});

test("failed activation preserves newer manual edits and unavailable backends cannot save", async t => {
  const { root, store } = await fixture(t);
  let available = false;
  const importer = { managedPath: join(root, "managed.json"), refresh: async () => {
    await writeFile(join(root, "agents/x.md"), encodeAgentFile({ description: "Newer manual edit" }));
    throw new Error("synthetic activation failure");
  } };
  const client = { server: { info: async () => { if (!available) throw new Error(); } } };
  const bridge = createAgentSettingsBridge({ store, client, importer, permissions, workspace: root });
  await assert.rejects(bridge.handle("create", "x", { description: "Cannot save offline" }), /backend is unavailable/);
  assert.equal((await store.scan()).entries.size, 0);
  available = true;
  await assert.rejects(bridge.handle("create", "x", { description: "UI edit" }), /newer edit or storage failure prevented rollback/);
  assert.equal((await store.scan()).entries.get("x").config.description, "Newer manual edit");
});

test("persistent store supports nested agents, conditional updates/deletion, and does not read global JSON", async t => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, "opencode.json"), '{"agents":{"ignored":{"system":"{file:/private}"}}}');
  const first = await store.replace("agents/team/reviewer.md", null, encodeAgentFile(config));
  let snapshot = await store.scan();
  assert.deepEqual([...snapshot.entries.keys()], ["team/reviewer"]);
  assert.deepEqual(snapshot.entries.get("team/reviewer").config, config);
  assert.deepEqual(snapshot.errors, []);
  await assert.rejects(store.replace("agents/team/reviewer.md", null, encodeAgentFile({})), /concurrently/);
  const second = await store.replace("agents/team/reviewer.md", first, encodeAgentFile({ description: "Changed" }));
  await assert.rejects(store.replace("agents/team/reviewer.md", first, null), /concurrently/);
  await store.replace("agents/team/reviewer.md", second, null);
  assert.equal((await store.scan()).entries.size, 0);
});

test("invalid, linked, duplicated and oversized definitions never replace valid neighbors", async t => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, "agents")); await mkdir(join(root, "agent"));
  await writeFile(join(root, "agents/valid.md"), encodeAgentFile(config), { mode: 0o600 });
  await writeFile(join(root, "agents/invalid.md"), "---\nplugins: [evil]\n---\n", { mode: 0o600 });
  await writeFile(join(root, "agents/large.md"), "x".repeat(65537), { mode: 0o600 });
  await link(join(root, "agents/valid.md"), join(root, "agents/hardlink.md"));
  let snapshot = await store.scan();
  assert.equal(snapshot.entries.size, 0, "both hardlink names must be rejected");
  assert.ok(snapshot.errors.length >= 4);
  await rm(join(root, "agents/hardlink.md"));
  await writeFile(join(root, "agent/valid.md"), encodeAgentFile(config), { mode: 0o600 });
  snapshot = await store.scan();
  assert.equal(snapshot.entries.size, 0);
  assert.ok(snapshot.errors.some(error => /Duplicate/.test(error.message)));
});

test("Linux refuses unsafe parent/root/agent directory links and group-writable files", { skip: process.platform !== "linux" }, async t => {
  const { root, store } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "ha-agent-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "agents"));
  await assert.rejects(store.scan());
  await assert.rejects(store.replace("agents/x.md", null, encodeAgentFile(config)));
  await rm(join(root, "agents")); await mkdir(join(root, "agents"));
  await writeFile(join(root, "agents/unsafe.md"), encodeAgentFile(config));
  await chmod(join(root, "agents/unsafe.md"), 0o660);
  assert.equal((await store.scan()).entries.size, 0);
  const linkedRoot = join(root, "alias"); await symlink(outside, linkedRoot);
  await assert.rejects(createAgentStore(join(linkedRoot, "child")).replace("agents/x.md", null, encodeAgentFile(config)));
});

test("UI controller validates before writing, serializes mutations, verifies activation, and restores failed writes", async t => {
  const { root, store } = await fixture(t);
  let failures = false, writes = 0;
  const managedPath = join(root, "managed.json");
  const importer = { managedPath, refresh: async () => { if (failures) { writes++; throw new Error("private backend error"); } const scanned = await store.scan(); return { applied: [...scanned.entries.keys()], rejected: scanned.errors }; } };
  const client = {
    server: { info: async () => ({ version: "2.1.2" }) },
    config: { get: async () => [{ type: "document", path: managedPath, info: { agents: Object.fromEntries([...(await store.scan()).entries].map(([id, entry]) => [id, constrainAgent(entry.config, guards)])) } }] },
    agent: { get: async ({ agentID }) => { const entry = (await store.scan()).entries.get(agentID); return { data: entry ? constrainAgent(entry.config, guards) : null }; } },
  };
  const bridge = createAgentSettingsBridge({ store, client, importer, permissions, workspace: root });
  await assert.rejects(bridge.handle("create", "x", { plugins: ["private-value"] }), /native V2/);
  await assert.rejects(bridge.handle("create", "x", { scope: "project" }), /Only global/);
  await assert.rejects(bridge.handle("update", "home-assistant-read-only", config), /managed/);
  assert.equal((await store.scan()).entries.size, 0);
  assert.equal((await bridge.handle("create", "x", config)).applied, true);
  await Promise.all([bridge.handle("update", "x", { description: "One" }), bridge.handle("update", "x", { color: "#abcdef" })]);
  let entry = (await store.scan()).entries.get("x");
  assert.equal(entry.config.description, "One"); assert.equal(entry.config.color, "#abcdef");
  failures = true;
  await assert.rejects(bridge.handle("update", "x", { description: "Must roll back" }), /previous saved settings were restored/);
  assert.equal((await store.scan()).entries.get("x").config.description, "One");
  failures = false;
  assert.equal((await bridge.handle("delete", "x")).applied, true);
  assert.equal((await store.scan()).entries.size, 0);
  assert.ok(!(await readFile(join(root, "opencode.json")).catch(() => Buffer.from(""))).length);
});
