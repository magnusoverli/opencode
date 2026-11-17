#!/usr/bin/env node
// Retire only the beta's private, byte-for-byte app-owned instruction copy.
// Shared /homeassistant/AGENTS.md and edited/unverifiable files are not ours.
import { lstat, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

async function boundedFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error("Unsafe legacy file");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("Oversized legacy file");
    return { info, bytes: buffer.subarray(0, bytesRead) };
  } finally { await file.close(); }
}

export async function retireInstructions(dataRoot = "/data") {
  const target = join(dataRoot, "context", "AGENTS.md");
  const marker = join(dataRoot, ".agents_md_hash");
  try {
    for (let parent = dirname(target); ; parent = dirname(parent)) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe legacy directory");
      if (parent === dirname(parent)) break;
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe legacy file");
    const [file, ownership] = await Promise.all([boundedFile(target, 256 * 1024), boundedFile(marker, 128)]);
    const expected = ownership.bytes.toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(file.bytes).digest("hex") !== expected) {
      return { status: "preserved", reason: "edited_or_unverified", path: target };
    }
    const current = await lstat(target);
    if (current.dev !== file.info.dev || current.ino !== file.info.ino || current.size !== file.info.size ||
        current.mtimeMs !== file.info.mtimeMs || current.isSymbolicLink()) throw new Error("Changed legacy file");
    await unlink(target);
    // Keep the historical marker: it is harmless and may be needed to identify
    // an older shared copy. Never use it here to delete a shared file.
    return { status: "retired", path: target };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "preserved_or_absent", path: target };
    return { status: "preserved", reason: "unsafe_or_unavailable", path: target };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.ADDON_CHANNEL === "beta") {
    const result = await retireInstructions();
    console.log(`Legacy beta instructions: ${result.status}`);
    if (result.status === "preserved") console.warn("Review /data/context/AGENTS.md and move wanted custom rules to /homeassistant/AGENTS.local.md; the legacy file is not loaded.");
  }
}
