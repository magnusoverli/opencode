/** One coordinated writer for the v1 notes file and its disposable digest. */
import * as fs from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DECISION_NOTES_PATH, DECISION_DIGEST_PATH, LIMITS,
  parseDecisionNotes, renderDecisionDigest,
} from "./decision-notes.js";

const BACKUP_HEADER = "# ha-opencode-managed-last-good-v1\n";
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const hash = (text) => createHash("sha256").update(text).digest("hex");
// Windows can report a delete-pending lock as access denied rather than EEXIST.
const sharingViolation = (error) => process.platform === "win32" && ["EACCES", "EPERM", "EBUSY"].includes(error.code);

export class DecisionStoreError extends Error {}

export function createDecisionStore({
  notesPath = DECISION_NOTES_PATH,
  digestPath = DECISION_DIGEST_PATH,
  secretValues = () => [],
  io = fs,
  lockTimeoutMs = 5000,
} = {}) {
  const lockPath = `${notesPath}.lock`;
  const backupPath = `${notesPath}.backup`;

  function read(path, maximum) {
    let fd;
    try {
      if (io.lstatSync(path).isSymbolicLink()) throw new DecisionStoreError("Decision-notes source is a symbolic link; nothing was modified.");
      fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const info = io.fstatSync(fd);
      if (!info.isFile()) throw new DecisionStoreError("Decision-notes path is not a regular file; nothing was modified.");
      if (info.size > maximum) throw new DecisionStoreError("Decision-notes file exceeds its size safety limit (2 MiB for notes); nothing was modified. Back it up and review it locally without deleting history.");
      const buffer = Buffer.alloc(Math.min(maximum + 1, info.size + 1));
      let size = 0;
      while (size < buffer.length) {
        const count = io.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = io.fstatSync(fd);
      if (size > maximum || size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new DecisionStoreError("Decision-notes source changed while reading; retry without overwriting it.");
      return buffer.subarray(0, size).toString("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof DecisionStoreError) throw error;
      throw new DecisionStoreError("Decision-notes source is unavailable or unsafe; nothing was modified. Review its permissions and file type locally.");
    } finally {
      if (fd !== undefined) io.closeSync(fd);
    }
  }

  function load() {
    try {
      const source = read(notesPath, LIMITS.maxFileBytes);
      const parsed = parseDecisionNotes(source ?? "");
      // Assign rather than spread: parsed state carries non-enumerable user metadata.
      return Object.assign(parsed, { source, exists: source !== null, revision: hash(`${source === null ? "missing" : "present"}\0${source ?? ""}`) });
    } catch (error) {
      return { ok: false, exists: true, notes: [], errors: [error.message], rejected: 0, revision: null };
    }
  }

  function identity(pid) {
    if (process.platform !== "linux") return null;
    try {
      const stat = io.readFileSync(`/proc/${pid}/stat`, "utf8");
      return `${io.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    } catch { return null; }
  }

  function dead(owner) {
    if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") return false;
    try {
      process.kill(owner.pid, 0);
      const current = identity(owner.pid);
      return Boolean(owner.identity && current && owner.identity !== current);
    } catch (error) { return error.code === "ESRCH"; }
  }

  function recoverDeadLock() {
    // Only one reaper may inspect/remove a dead owner's lock. Without this guard,
    // two reapers could remove a new writer's lock after inspecting the old one.
    const recovery = `${lockPath}.recovery`;
    let fd;
    try {
      fd = io.openSync(recovery, "wx", 0o600);
      const before = read(lockPath, 4096);
      if (!before) return;
      let owner;
      try { owner = JSON.parse(before); } catch { return; }
      if (dead(owner) && read(lockPath, 4096) === before) io.unlinkSync(lockPath);
    } catch (error) {
      // The owner may still be filling its lock file. Unreadable or unknown
      // locks are never removed; a later attempt can inspect a complete record.
      if (error instanceof DecisionStoreError || sharingViolation(error)) return;
      if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) {
        io.closeSync(fd);
        io.unlinkSync(recovery);
      }
    }
  }

  function locked(operation) {
    io.mkdirSync(dirname(notesPath), { recursive: true });
    if (!io.lstatSync(dirname(notesPath)).isDirectory() || io.lstatSync(dirname(notesPath)).isSymbolicLink()) {
      throw new DecisionStoreError("Decision-notes directory is unsafe; nothing was modified.");
    }
    const owner = JSON.stringify({ version: 1, pid: process.pid, identity: identity(process.pid), token: randomUUID() });
    const until = Date.now() + lockTimeoutMs;
    for (;;) {
      let fd;
      try {
        fd = io.openSync(lockPath, "wx", 0o600);
        io.writeFileSync(fd, owner, "utf8");
        io.fsyncSync(fd);
      } catch (error) {
        const contention = error.code === "EEXIST" || (fd === undefined && sharingViolation(error));
        if (fd !== undefined) { io.closeSync(fd); io.unlinkSync(lockPath); }
        if (!contention) throw new DecisionStoreError("Could not acquire the decision-notes writer lock; nothing was changed.");
        recoverDeadLock();
        if (Date.now() >= until) throw new DecisionStoreError("Decision notes are busy or their lock needs local review. No notes were changed; retry, or review the .lock/.lock.recovery files after confirming no writer is running.");
        Atomics.wait(sleepBuffer, 0, 0, 25);
        continue;
      }
      io.closeSync(fd);
      let result;
      try { result = operation(); }
      finally {
        try {
          if (read(lockPath, 4096) === owner) io.unlinkSync(lockPath);
          else if (result) result.lockWarning = "The writer lock changed unexpectedly; review it locally before another write.";
        } catch {
          // A cleanup error must not turn a committed note into an apparent
          // rejection that encourages a duplicate write. Preserve unknown locks.
          if (result) result.lockWarning = "Writer lock cleanup failed; review the lock locally before another write.";
        }
      }
      return result;
    }
  }

  function atomic(path, contents) {
    io.mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = io.openSync(temporary, "wx", 0o600);
      io.writeFileSync(fd, contents, "utf8");
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, path);
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      try { io.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  function publishDigest() {
    const current = load();
    const digest = renderDecisionDigest(current.notes, { secretValues: secretValues(), unreadable: current.rejected });
    if (!digest.markdown && !current.ok) {
      digest.markdown = "# Decision notes\n\nThe decision-notes record could not be read safely or completely. Do not treat this as an absence of decisions. Tell the user to review the file or restore a backup; no history was removed.\n";
      digest.bytes = Buffer.byteLength(digest.markdown);
    }
    const previous = read(digestPath, 32 * 1024);
    if (previous === (digest.markdown || null)) return { digest, changed: false, readable: current.ok };
    if (digest.markdown) atomic(digestPath, digest.markdown);
    else if (previous !== null) io.unlinkSync(digestPath);
    return { digest, changed: true, readable: current.ok };
  }

  function refresh() {
    return locked(publishDigest);
  }

  function mutate(change) {
    return locked(() => {
      const existing = load();
      if (!existing.ok) return { error: `Cannot write decision notes: ${existing.errors.slice(0, 3).join(" ")} The original file was not overwritten.` };
      const result = change(existing);
      if (result.error) return result;
      if (typeof result.serialized !== "string" || Buffer.byteLength(result.serialized) > LIMITS.maxFileBytes || !parseDecisionNotes(result.serialized).ok) {
        return { error: "The proposed notes file is invalid or exceeds 2 MiB; nothing was changed." };
      }
      if (existing.exists) {
        const backup = read(backupPath, LIMITS.maxFileBytes + BACKUP_HEADER.length);
        if (backup !== null && !backup.startsWith(BACKUP_HEADER)) {
          return { error: "The decision-notes .backup path contains an unrecognised file. It was not overwritten; review it locally before retrying." };
        }
        atomic(backupPath, BACKUP_HEADER + existing.source);
      }
      // App writers share the lock. Arbitrary external editors do not: detect an
      // observed edit rather than pretending rename offers filesystem-wide CAS.
      if (load().revision !== existing.revision) return { error: "Decision notes changed during this operation. Nothing was overwritten; recall the current record and retry." };
      atomic(notesPath, result.serialized);
      try {
        const published = publishDigest();
        return { ...result, ...published, ...(!published.readable ? {
          digestError: "Saved; context refresh failed because the current record is no longer readable. Review the file locally; an unavailability notice was published instead of stale decisions.",
        } : {}) };
      }
      catch { return { ...result, digestError: "Saved; context refresh failed. The standing digest may be stale. Review the add-on log/permissions and run ha-context refresh to retry." }; }
    });
  }

  return { load, mutate, refresh, notesPath, digestPath, backupPath };
}
