import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, readdir, stat, chmod, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentImporter, initializeAgentImporter, readManagedDocument } from "../rootfs/opt/opencode-v2-homeassistant/agents-importer.js";
import { createAgentStore, encodeAgentFile } from "../rootfs/opt/opencode-v2-homeassistant/agents-store.js";
import { constrainAgent, agentPolicy } from "../rootfs/opt/opencode-v2-homeassistant/agents-policy.js";
import { buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ha-agents-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = buildManagedConfig();
  const managedPath = join(root, "managed.json"), basePath = join(root, "agents-base.json");
  const store = createAgentStore(join(root, "persistent"));
  await writeFile(managedPath, JSON.stringify(base), { mode: 0o600 });
  return { root, base, store, managedPath, basePath };
}

test("startup retains the private image base, publishes only validated agents, and refreshes atomically", async t => {
  const f = await fixture(t);
  const config = { description: "Persisted", permissions: [{ action: "edit", resource: "*", effect: "deny" }] };
  await f.store.replace("mode/team/reviewer.md", null, encodeAgentFile(config));
  await initializeAgentImporter(f.managedPath, { basePath: f.basePath, store: f.store });
  assert.deepEqual((await readManagedDocument(f.basePath)).value, f.base);
  const importer = createAgentImporter(f);
  assert.deepEqual((await importer.refresh()).applied, ["team/reviewer"]);
  let current = await readManagedDocument(f.managedPath);
  assert.deepEqual(current.value.agents["team/reviewer"], constrainAgent({ ...config, system: "" }, agentPolicy(f.base.permissions)));
  assert.deepEqual(current.value.plugins, f.base.plugins);
  if (process.platform === "linux") assert.equal((await stat(f.managedPath)).mode & 0o777, 0o600);
  const etag = current.etag;
  await Promise.all([importer.refresh(), importer.refresh()]);
  assert.equal((await readManagedDocument(f.managedPath)).etag, etag, "no-op refresh must not rewrite config");
  await writeFile(join(f.store.root, "mode/team/reviewer.md"), "---\nplugins: [unsafe]\n---\n");
  const retained = await importer.refresh();
  assert.equal(retained.rejected[0].id, "team/reviewer");
  assert.equal((await readManagedDocument(f.managedPath)).etag, etag);
  // UI process restart must retain a validated override even if its source is
  // now malformed; a full add-on restart starts again from the image base.
  await createAgentImporter(f).refresh();
  assert.equal((await readManagedDocument(f.managedPath)).etag, etag);
  await rm(join(f.store.root, "mode/team/reviewer.md"));
  await importer.refresh();
  assert.equal((await readManagedDocument(f.managedPath)).value.agents["team/reviewer"], undefined);
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith(".agent-config-")));
  await assert.rejects(initializeAgentImporter(f.managedPath, { basePath: f.basePath, store: f.store }), /concurrently/);
});

test("image-owned agents win and unrelated managed edits cannot be overwritten", async t => {
  const f = await fixture(t);
  f.base.agents.futureManaged = { description: "Image-owned agent" };
  await writeFile(f.managedPath, JSON.stringify(f.base), { mode: 0o600 });
  await f.store.replace("agents/futureManaged.md", null, encodeAgentFile({ description: "Cannot replace image policy" }));
  const importer = createAgentImporter(f);
  await importer.refresh();
  assert.deepEqual((await readManagedDocument(f.managedPath)).value.agents.futureManaged, f.base.agents.futureManaged);
  const changed = { ...f.base, instructions: ["manual-private-edit"] };
  await writeFile(f.managedPath, JSON.stringify(changed));
  await assert.rejects(importer.refresh(), /concurrently/);
  await assert.rejects(createAgentImporter(f).refresh(), /unsafe/);
  assert.deepEqual(JSON.parse(await readFile(f.managedPath)), changed);
});

test("publisher detects an intervening write and never publishes a partial snapshot", async t => {
  const f = await fixture(t);
  await f.store.replace("agents/x.md", null, encodeAgentFile({ description: "Requires publication" }));
  const realScan = f.store.scan;
  const changed = { ...f.base, default_agent: "plan" };
  f.store.scan = async () => { await writeFile(f.managedPath, JSON.stringify(changed)); return realScan(); };
  await assert.rejects(createAgentImporter(f).refresh(), /concurrently/);
  assert.deepEqual(JSON.parse(await readFile(f.managedPath)), changed);
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith(".agent-config-")));
});

test("private documents reject corrupt JSON, hardlinks, symlinks and public permissions", async t => {
  const f = await fixture(t);
  await writeFile(f.managedPath, "not JSON");
  await assert.rejects(readManagedDocument(f.managedPath), /unsafe/);
  await writeFile(f.managedPath, JSON.stringify(f.base));
  const alias = join(f.root, "linked.json");
  await link(f.managedPath, alias);
  await assert.rejects(readManagedDocument(f.managedPath), /unsafe/);
  await rm(alias);
  if (process.platform === "linux") {
    await chmod(f.managedPath, 0o644);
    await assert.rejects(readManagedDocument(f.managedPath), /unsafe/);
    await chmod(f.managedPath, 0o600);
    await symlink(f.managedPath, alias);
    await assert.rejects(readManagedDocument(alias));
  }
});
