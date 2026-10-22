import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createDecisionStore } from "../lib/decision-store.js";
import { addNote, LIMITS, renderDecisionDigest, serializeDecisionNotes, supersedeNotes } from "../lib/decision-notes.js";

const NOW = new Date("2026-10-22T12:00:00Z");
let dir, notesPath, digestPath, store;
const input = (title = "Approved choice") => ({ title, decision: "Keep the approved configuration." });
const add = (target = store, title) => target.mutate((state) => addNote(state, input(title), { now: NOW }));

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "decision-store-"));
  notesPath = join(dir, "decisions.yaml");
  digestPath = join(dir, "digest.md");
  store = createDecisionStore({ notesPath, digestPath });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("decision-note storage", () => {
  it("distinguishes missing, malformed, unsupported and oversized records", () => {
    expect(store.load()).toMatchObject({ ok: true, exists: false, notes: [] });
    for (const text of ["notes: [broken", "version: 2\nnotes: []", " ".repeat(LIMITS.maxFileBytes + 1)]) {
      fs.writeFileSync(notesPath, text);
      expect(store.load()).toMatchObject({ ok: false, exists: true });
      expect(add().error).toContain("not overwritten");
      expect(fs.readFileSync(notesPath, "utf8")).toBe(text);
    }
  });

  it("unblocks the 56-note/38-active full-file scenario without discarding history", () => {
    const notes = Array.from({ length: 56 }, (_, i) => ({
      id: `note-${i}`, date: "2026-10-01", title: `Note ${i}`, decision: "Keep this choice.",
      rationale: "Approved historical reasoning. ".repeat(40), status: i < 38 ? "active" : "superseded",
    }));
    const original = serializeDecisionNotes({ version: 1, notes });
    expect(Buffer.byteLength(original)).toBeGreaterThan(64 * 1024);
    fs.writeFileSync(notesPath, original);
    const result = add();
    expect(result.error).toBeUndefined();
    expect(store.load().notes).toHaveLength(57);
    expect(fs.readFileSync(store.backupPath, "utf8")).toContain(original);
    expect(Buffer.byteLength(fs.readFileSync(digestPath))).toBeLessThanOrEqual(2048);
    expect(store.load().notes.filter((note) => note.status === "superseded")).toHaveLength(18);
  });

  it("keeps an exact last-good preimage, including comments, and refreshes after retiring", () => {
    const first = add();
    const original = fs.readFileSync(notesPath, "utf8") + "\n# user's comment\n";
    fs.writeFileSync(notesPath, original);
    const result = store.mutate((state) => supersedeNotes(state, [first.note.id]));
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(store.backupPath, "utf8")).toBe("# ha-opencode-managed-last-good-v1\n" + original);
    expect(fs.existsSync(digestPath)).toBe(false);
    expect(store.load().notes[0].status).toBe("superseded");
    const backup = fs.readFileSync(store.backupPath, "utf8");
    fs.writeFileSync(notesPath, backup.slice(backup.indexOf("\n") + 1));
    expect(store.load().notes[0].status).toBe("active");
    expect(store.refresh().readable).toBe(true);
  });

  it("rejects a write exceeding 2 MiB without changing or pruning the existing record", () => {
    const original = JSON.stringify({ version: 1, notes: [], extra: "x".repeat(LIMITS.maxFileBytes - 60) });
    expect(Buffer.byteLength(original)).toBeLessThanOrEqual(LIMITS.maxFileBytes);
    fs.writeFileSync(notesPath, original);
    expect(store.load().ok).toBe(true);
    expect(add().error).toContain("2 MiB");
    expect(fs.readFileSync(notesPath, "utf8")).toBe(original);
    expect(fs.existsSync(store.backupPath)).toBe(false);
  });

  it("does not overwrite an unrelated backup or the legacy .bak path", () => {
    add();
    const original = fs.readFileSync(notesPath, "utf8");
    fs.writeFileSync(store.backupPath, "user-owned backup");
    fs.writeFileSync(`${notesPath}.bak`, "legacy backup");
    expect(add(store, "Second choice").error).toContain("unrecognised");
    expect(fs.readFileSync(notesPath, "utf8")).toBe(original);
    expect(fs.readFileSync(store.backupPath, "utf8")).toBe("user-owned backup");
    expect(fs.readFileSync(`${notesPath}.bak`, "utf8")).toBe("legacy backup");
  });

  it("leaves the notes unchanged on backup or notes-rename failure and removes temporary files", () => {
    add();
    const original = fs.readFileSync(notesPath, "utf8");
    for (const destination of [store.backupPath, notesPath]) {
      const failing = createDecisionStore({ notesPath, digestPath, io: { ...fs, renameSync(from, to) {
        if (to === destination) throw Object.assign(new Error("fixture disk failure"), { code: "EIO" });
        return fs.renameSync(from, to);
      } } });
      expect(() => add(failing, "Second choice")).toThrow();
      expect(fs.readFileSync(notesPath, "utf8")).toBe(original);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
    }
  });

  it("detects an observed external edit rather than overwrite it", () => {
    add();
    const edited = fs.readFileSync(notesPath, "utf8") + "\n# concurrent manual edit\n";
    const changed = createDecisionStore({ notesPath, digestPath, io: { ...fs, renameSync(from, to) {
      fs.renameSync(from, to);
      if (to === store.backupPath) fs.writeFileSync(notesPath, edited);
    } } });
    expect(add(changed, "Second choice").error).toContain("changed during");
    expect(fs.readFileSync(notesPath, "utf8")).toBe(edited);
  });

  it("reports saved-but-refresh-failed without losing or falsely rejecting the saved note", () => {
    fs.writeFileSync(digestPath, "old context");
    const failing = createDecisionStore({ notesPath, digestPath, io: { ...fs, renameSync(from, to) {
      if (to === digestPath) throw new Error("fixture refresh failure");
      fs.renameSync(from, to);
    } } });
    const result = add(failing);
    expect(result.error).toBeUndefined();
    expect(result.digestError).toContain("Saved; context refresh failed");
    expect(store.load().notes).toHaveLength(1);
    expect(fs.readFileSync(digestPath, "utf8")).toBe("old context");
    expect(store.refresh().changed).toBe(true);
    expect(fs.readFileSync(digestPath, "utf8")).toContain("Approved choice");
  });

  it("does not rewrite unchanged digest content", () => {
    add();
    const before = fs.statSync(digestPath).mtimeMs;
    expect(store.refresh().changed).toBe(false);
    expect(fs.statSync(digestPath).mtimeMs).toBe(before);
  });

  it("does not misreport a committed write if lock cleanup fails", () => {
    const failing = createDecisionStore({ notesPath, digestPath, io: { ...fs, unlinkSync(file) {
      if (file === `${notesPath}.lock`) throw Object.assign(new Error("fixture lock cleanup failure"), { code: "EACCES" });
      return fs.unlinkSync(file);
    } } });
    const result = add(failing);
    expect(result.error).toBeUndefined();
    expect(result.lockWarning).toContain("cleanup failed");
    expect(store.load().notes).toHaveLength(1);
  });

  it("reports a readable-context failure separately if an external edit follows a committed write", () => {
    const changed = createDecisionStore({ notesPath, digestPath, io: { ...fs, renameSync(from, to) {
      fs.renameSync(from, to);
      if (to === notesPath) fs.writeFileSync(notesPath, "notes: [broken");
    } } });
    const result = add(changed);
    expect(result.error).toBeUndefined();
    expect(result.digestError).toContain("no longer readable");
    expect(fs.readFileSync(digestPath, "utf8")).toContain("Do not treat this as an absence");
  });

  it("publishes an explicit notice instead of silently removing unreadable context", () => {
    add();
    fs.writeFileSync(notesPath, "notes: [broken");
    expect(store.refresh().readable).toBe(false);
    expect(fs.readFileSync(digestPath, "utf8")).toContain("Do not treat this as an absence");
    expect(Buffer.byteLength(fs.readFileSync(digestPath))).toBeLessThanOrEqual(2048);
  });

  it("refuses live or unrecognised locks without removing them", () => {
    for (const owner of ["user-owned file", JSON.stringify({ version: 1, pid: process.pid, token: "fixture", identity: null })]) {
      fs.writeFileSync(`${notesPath}.lock`, owner);
      const busy = createDecisionStore({ notesPath, digestPath, lockTimeoutMs: 30 });
      expect(() => add(busy)).toThrow(/busy|lock/);
      expect(fs.readFileSync(`${notesPath}.lock`, "utf8")).toBe(owner);
      expect(fs.existsSync(notesPath)).toBe(false);
    }
  });

  it("recovers a verified dead process lock", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(`${notesPath}.lock`, JSON.stringify({ version: 1, pid: dead.pid, token: "fixture", identity: null }));
    expect(add().error).toBeUndefined();
    expect(fs.existsSync(`${notesPath}.lock`)).toBe(false);
    expect(fs.existsSync(`${notesPath}.lock.recovery`)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses symlink sources without exposing or replacing their targets", () => {
    const target = join(dir, "unrelated.yaml");
    fs.writeFileSync(target, serializeDecisionNotes({ version: 1, notes: [] }));
    fs.symlinkSync(target, notesPath);
    expect(store.load().ok).toBe(false);
    expect(add().error).toContain("symbolic link");
    expect(fs.lstatSync(notesPath).isSymbolicLink()).toBe(true);
  });

  it("serializes independent writers and refresh processes without losing notes or publishing an old snapshot", async () => {
    const module = pathToFileURL(join(import.meta.dirname, "../lib/decision-store.js")).href;
    const notesModule = pathToFileURL(join(import.meta.dirname, "../lib/decision-notes.js")).href;
    const run = (i) => new Promise((resolve, reject) => {
      const code = `import {createDecisionStore} from ${JSON.stringify(module)};
        import {addNote} from ${JSON.stringify(notesModule)};
        const s=createDecisionStore({notesPath:${JSON.stringify(notesPath)},digestPath:${JSON.stringify(digestPath)}});
        const r=${i < 0 ? "s.refresh()" : `s.mutate(state=>addNote(state,{title:'Parallel ${i}',decision:'Keep this approved setting.'},{now:new Date('2026-10-22T12:00:00Z')}))`};
        if(r.error||r.digestError) throw Error('fixture failed');`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (data) => { error += data; });
      child.on("error", reject);
      child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(error)));
    });
    await Promise.all([0, -1, 1, 2, -1, 3, 4, -1, 5].map(run));
    const current = store.load();
    expect(current.ok).toBe(true);
    expect(current.notes).toHaveLength(6);
    expect(new Set(current.notes.map((note) => note.id)).size).toBe(6);
    expect(fs.readFileSync(digestPath, "utf8")).toBe(renderDecisionDigest(current.notes).markdown);
  }, 20000);
});
