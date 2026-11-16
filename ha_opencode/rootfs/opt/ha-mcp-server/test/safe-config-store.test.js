import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeConfigWriter } from "../lib/safe-config-store.js";
import { spawnSync } from "node:child_process";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(io = fs) {
  const root = fs.mkdtempSync(join(tmpdir(), "safe-transaction-")); roots.push(root);
  const path = join(root, "automations.yaml");
  fs.writeFileSync(path, "original", { mode: 0o640 });
  return { root, path, store: createSafeConfigWriter({ root, io }) };
}

describe("safe config transactions", () => {
  it("requires the reviewed revision and never overwrites stale content", async () => {
    const f = fixture(); const revision = f.store.revision(f.path);
    fs.writeFileSync(f.path, "external");
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: revision, validate: async () => true });
    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(f.path, "utf8")).toBe("external");
  });
  it("atomically replaces content, retains verified recovery and preserves mode", async () => {
    const f = fixture(); const revision = f.store.revision(f.path);
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: revision, validate: async () => true });
    expect(result.status).toBe("saved");
    expect(fs.readFileSync(f.path, "utf8")).toBe("new");
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(result.backupPath, "utf8")).toBe("original");
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
  });
  it.each([false, "throws"])("verifies rollback when validation returns %s", async outcome => {
    const f = fixture();
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => {
      if (outcome === "throws") throw new Error("PRIVATE-CREDENTIAL");
      return false;
    } });
    expect(result.status).toBe("restored");
    expect(fs.readFileSync(f.path, "utf8")).toBe("original");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-CREDENTIAL");
  });
  it("does not roll back over an external writer", async () => {
    const f = fixture();
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => {
      fs.writeFileSync(f.path, "external"); return false;
    } });
    expect(result.status).toBe("recovery_required");
    expect(fs.readFileSync(f.path, "utf8")).toBe("external");
    expect(fs.readFileSync(result.backupPath, "utf8")).toBe("original");
  });
  it("never claims success after an external write during validation", async () => {
    const f = fixture();
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => {
      fs.writeFileSync(f.path, "external"); return true;
    } });
    expect(result.status).toBe("recovery_required");
  });
  it("removes an invalid new file and preserves its missing baseline", async () => {
    const f = fixture(); fs.unlinkSync(f.path);
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: "missing", validate: async () => false });
    expect(result.status).toBe("restored"); expect(fs.existsSync(f.path)).toBe(false);
  });
  it("rejects linked destinations without touching the target", async () => {
    const f = fixture(); const target = join(f.root, "target");
    fs.renameSync(f.path, target); fs.symlinkSync(target, f.path);
    expect(() => f.store.revision(f.path)).toThrow();
    fs.unlinkSync(f.path); fs.linkSync(target, f.path);
    expect(() => f.store.revision(f.path)).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });
  it("rejects linked ancestors and out-of-root paths", () => {
    const f = fixture(); fs.symlinkSync(f.root, join(f.root, "link"));
    expect(() => f.store.revision(join(f.root, "link/automations.yaml"))).toThrow();
    expect(() => f.store.revision(join(f.root, "../outside"))).toThrow();
  });
  it("fails closed on an existing lock or an interrupted transaction", async () => {
    const f = fixture(); fs.mkdirSync(join(f.root, ".opencode-safe-write.lock"));
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => true });
    expect(result.status).toBe("busy"); expect(fs.readFileSync(f.path, "utf8")).toBe("original");
  });
  it("does not report restoration if rollback replacement fails", async () => {
    let replacements = 0;
    const f = fixture({ ...fs, renameSync: (...args) => {
      if (args[1].endsWith("automations.yaml") && ++replacements === 2) throw Object.assign(new Error("synthetic"), { code: "EIO" });
      return fs.renameSync(...args);
    } });
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => false });
    expect(result.status).toBe("recovery_required");
    expect(fs.readFileSync(f.path, "utf8")).toBe("new");
    expect(fs.existsSync(join(f.root, ".opencode-safe-write.lock"))).toBe(true);
  });
  it("holds the shared lock across asynchronous validation of different files", async () => {
    const f = fixture(); const other = join(f.root, "scripts.yaml"); fs.writeFileSync(other, "original");
    let complete;
    const pending = f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: () => new Promise(resolve => { complete = resolve; }) });
    const second = await f.store.write({ path: other, content: "different", expectedRevision: f.store.revision(other), validate: async () => true });
    expect(second.status).toBe("busy");
    expect(fs.readFileSync(other, "utf8")).toBe("original");
    complete(true); expect((await pending).status).toBe("saved");
  });
  it.each(["writeFileSync", "fsyncSync"])("fails closed before committing when %s fails", async operation => {
    const f = fixture({ ...fs, [operation]: () => { throw Object.assign(new Error("PRIVATE"), { code: "ENOSPC" }); } });
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => true });
    expect(result.status).toBe("rejected");
    expect(fs.readFileSync(f.path, "utf8")).toBe("original");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("preserves unknown recovery entries and refuses to reuse the directory", async () => {
    const f = fixture(); const recovery = join(f.root, ".opencode-safe-write-backups");
    fs.mkdirSync(recovery, { mode: 0o700 }); fs.writeFileSync(join(recovery, "unknown"), "keep");
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: f.store.revision(f.path), validate: async () => true });
    expect(result.status).toBe("rejected");
    expect(fs.readFileSync(join(recovery, "unknown"), "utf8")).toBe("keep");
    expect(fs.readFileSync(f.path, "utf8")).toBe("original");
  });
  it("does not allow the tool to overwrite its recovery records", async () => {
    const f = fixture();
    const result = await f.store.write({ path: join(f.root, ".opencode-safe-write-backups/example.json"), content: "{}", expectedRevision: "missing", validate: async () => true });
    expect(result.reason).toBe("reserved_transaction_path");
  });
  it("never clobbers a file created after the reviewed missing-source check", async () => {
    const f = fixture({ ...fs, linkSync: (from, to) => {
      fs.writeFileSync(to, "external"); return fs.linkSync(from, to);
    } });
    fs.unlinkSync(f.path);
    const result = await f.store.write({ path: f.path, content: "new", expectedRevision: "missing", validate: async () => true });
    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(f.path, "utf8")).toBe("external");
  });
  it.skipIf(process.platform !== "linux").each(["before_commit", "during_validation"])("preserves recovery and blocks a new process after SIGKILL %s", async stage => {
    const f = fixture();
    const moduleUrl = new URL("../lib/safe-config-store.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import * as fs from 'node:fs';
      import {createSafeConfigWriter} from ${JSON.stringify(moduleUrl)};
      const root = process.argv[1], path = root + '/automations.yaml';
      const io = {...fs, renameSync(from, to) {
        if (${JSON.stringify(stage)} === 'before_commit' && to === path) process.kill(process.pid, 'SIGKILL');
        return fs.renameSync(from, to);
      }};
      const store = createSafeConfigWriter({root, io});
      await store.write({path, content:'new', expectedRevision:store.revision(path), validate:async () => {
        process.kill(process.pid, 'SIGKILL'); return false;
      }});
    `, f.root], { timeout: 5000, encoding: "utf8" });
    expect(child.signal).toBe("SIGKILL");
    expect(fs.readFileSync(f.path, "utf8")).toBe(stage === "before_commit" ? "original" : "new");
    const files = fs.readdirSync(join(f.root, ".opencode-safe-write-backups"));
    expect(fs.readFileSync(join(f.root, ".opencode-safe-write-backups", files.find(name => name.endsWith(".bak"))), "utf8")).toBe("original");
    const restarted = createSafeConfigWriter({ root: f.root });
    const retry = await restarted.write({ path: f.path, content: "retry", expectedRevision: restarted.revision(f.path), validate: async () => true });
    expect(retry.status).toBe("busy");
  });
});
