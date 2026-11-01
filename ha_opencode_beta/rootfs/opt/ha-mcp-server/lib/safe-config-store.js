/** Durable safe-write coordinator. Locks coordinate cooperating app writers;
 * revision rechecks cannot provide atomic CAS against unrelated external editors.
 * An interrupted/uncertain transaction retains its lock and journal for review.
 */
import * as fs from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 16 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");

export function createSafeConfigWriter({ root = "/homeassistant", io = fs } = {}) {
  root = resolve(root);
  const lock = join(root, ".opencode-safe-write.lock");
  const recovery = join(root, ".opencode-safe-write-backups");

  function parents(path, create = false) {
    path = resolve(path);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Unsafe configuration destination.");
    const directories = [];
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      directories.unshift(parent);
      if (parent === dirname(parent)) break;
    }
    for (const directory of directories) {
      let info;
      try { info = io.lstatSync(directory); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        io.mkdirSync(directory, { mode: 0o750 });
        info = io.lstatSync(directory);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe configuration ancestor.");
    }
    return true;
  }

  function snapshot(path) {
    if (!parents(path)) return { bytes: null, revision: "missing", info: null };
    let fd;
    try {
      fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const info = io.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Unsafe or oversized configuration file.");
      const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, info.size + 1));
      let size = 0;
      while (size < buffer.length) {
        const count = io.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      const bytes = buffer.subarray(0, size);
      const after = io.fstatSync(fd);
      if (bytes.length > MAX_BYTES || bytes.length !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        throw new Error("Configuration changed while reading.");
      }
      return { bytes, revision: hash(bytes), info };
    } catch (error) {
      if (error.code === "ENOENT") return { bytes: null, revision: "missing", info: null };
      throw error;
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }

  function flushDirectory(path) {
    const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }

  function exclusive(path, bytes, info) {
    const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      io.writeFileSync(fd, bytes);
      if (info) {
        const current = io.fstatSync(fd);
        if (current.uid !== info.uid || current.gid !== info.gid) io.fchownSync(fd, info.uid, info.gid);
        io.fchmodSync(fd, info.mode & 0o777);
      }
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
  }

  function replace(path, bytes, info) {
    parents(path, true);
    const temporary = join(dirname(path), `.ha-safe-write-${randomUUID()}.tmp`);
    try {
      exclusive(temporary, bytes, info);
      if (!io.readFileSync(temporary).equals(bytes)) throw new Error("Staged integrity check failed.");
      parents(path);
      if (info === null) {
        // A reviewed missing destination can be installed without clobbering a
        // file another editor creates after the revision check.
        try { io.linkSync(temporary, path); }
        catch (error) {
          if (error.code === "EEXIST") throw Object.assign(new Error("New destination was created concurrently."), { code: "SOURCE_CONFLICT" });
          throw error;
        }
        io.unlinkSync(temporary);
      } else io.renameSync(temporary, path);
      flushDirectory(dirname(path));
      if (!snapshot(path).bytes?.equals(bytes)) throw new Error("Installed integrity check failed.");
    } finally {
      try { io.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  async function write({ path, content, expectedRevision, validate }) {
    const destination = relative(root, resolve(path));
    if (destination.split(sep).some(part => part.startsWith(".opencode-safe-write") || part.startsWith(".ha-safe-write-"))) {
      return { status: "rejected", reason: "reserved_transaction_path" };
    }
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) return { status: "rejected", reason: "invalid_content" };
    if (typeof expectedRevision !== "string" || !/^(?:missing|[a-f0-9]{64})$/.test(expectedRevision)) {
      return { status: "rejected", reason: "expected_revision_required" };
    }
    let before;
    try { before = snapshot(path); } catch { return { status: "rejected", reason: "unsafe_source" }; }
    if (before.revision !== expectedRevision) return { status: "conflict", saved: false };
    try { io.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { return { status: error.code === "EEXIST" ? "busy" : "rejected", saved: false, reason: "writer_lock_needs_review" }; }
    let retainLock = false;
    let attempted = false;
    let backupPath;
    let journalPath;
    const next = Buffer.from(content);
    const nextRevision = hash(next);
    let journal;
    const record = status => replace(journalPath, Buffer.from(JSON.stringify({ ...journal, status }) + "\n"));
    try {
      if (snapshot(path).revision !== expectedRevision) return { status: "conflict", saved: false };
      try { io.mkdirSync(recovery, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const info = io.lstatSync(recovery);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
        throw new Error("Unsafe recovery directory.");
      }
      let retainedBytes = 0;
      const retained = io.readdirSync(recovery);
      if (retained.length >= 256) throw new Error("Recovery inventory needs local review.");
      for (const name of retained) {
        if (!/^[a-f0-9-]{36}\.(?:bak|json)$/.test(name)) throw new Error("Unknown recovery entry.");
        const entry = io.lstatSync(join(recovery, name));
        if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600) throw new Error("Unsafe recovery entry.");
        retainedBytes += entry.size;
      }
      if (retainedBytes + (before.bytes?.length ?? 0) + 16384 > 256 * 1024 * 1024) throw new Error("Recovery storage needs local review.");
      const id = randomUUID();
      backupPath = before.bytes === null ? null : join(recovery, `${id}.bak`);
      journalPath = join(recovery, `${id}.json`);
      if (backupPath) {
        exclusive(backupPath, before.bytes);
        if (!snapshot(backupPath).bytes.equals(before.bytes)) throw new Error("Backup integrity check failed.");
      }
      journal = { format: "ha-safe-write/v1", path: relative(root, path), before: before.revision,
        after: nextRevision, backup: backupPath ? relative(root, backupPath) : null };
      record("prepared");
      flushDirectory(root);
      if (snapshot(path).revision !== expectedRevision) return { status: "conflict", saved: false, backupPath };
      attempted = true;
      replace(path, next, before.info);
      record("validating");
      let valid = false;
      try { valid = await validate() === true; } catch { /* Never echo credential-bearing network exceptions. */ }
      if (snapshot(path).revision !== nextRevision) {
        retainLock = true;
        record("external_change");
        return { status: "recovery_required", saved: null, reason: "destination_changed", backupPath, journalPath };
      }
      if (valid) {
        record("saved");
        return { status: "saved", saved: true, validated: true, revision: nextRevision, backupPath, journalPath };
      }
      // Re-read verified recovery bytes; never restore a backup altered in place.
      if (before.bytes === null) {
        io.unlinkSync(path);
        flushDirectory(dirname(path));
      } else {
        if (snapshot(backupPath).revision !== before.revision) throw new Error("Recovery copy changed.");
        if (snapshot(path).revision !== nextRevision) throw new Error("Destination changed before recovery.");
        replace(path, before.bytes, before.info);
      }
      if (snapshot(path).revision !== before.revision) throw new Error("Recovery verification failed.");
      record("restored");
      return { status: "restored", saved: false, validated: false, backupPath, journalPath };
    } catch (error) {
      // A failed rename/fsync may have committed. Keep lock and recovery records;
      // do not guess the final state or encourage an automatic retry.
      if (error.code === "SOURCE_CONFLICT") return { status: "conflict", saved: false, backupPath, journalPath };
      retainLock = attempted;
      return { status: attempted ? "recovery_required" : "rejected", saved: attempted ? null : false,
        reason: attempted ? "transaction_interrupted" : "backup_or_journal_failed", backupPath, journalPath };
    } finally {
      if (!retainLock) {
        try { io.rmdirSync(lock); flushDirectory(root); }
        catch { /* An undeleted lock fails subsequent writes closed. */ }
      }
    }
  }
  return { revision: path => snapshot(path).revision, snapshot, write };
}
