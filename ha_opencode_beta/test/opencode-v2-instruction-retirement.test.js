import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { retireInstructions } from "../rootfs/usr/local/bin/retire-opencode-instructions.mjs";

test("retirement removes only exact beta-owned bytes, preserves edits and leaves shared instructions alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-instruction-retirement-"));
  try {
    await mkdir(join(root, "context"));
    const file = join(root, "context/AGENTS.md");
    const shared = join(root, "AGENTS.md");
    const old = "Historical app-owned rules\n";
    await writeFile(shared, "stable/user rules");
    await writeFile(file, old);
    await writeFile(join(root, ".agents_md_hash"), createHash("sha256").update(old).digest("hex"));
    assert.equal((await retireInstructions(root)).status, "retired");
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(await readFile(shared, "utf8"), "stable/user rules");
    await writeFile(file, old + "my rules");
    assert.equal((await retireInstructions(root)).status, "preserved");
    assert.equal(await readFile(file, "utf8"), old + "my rules");
    await rm(join(root, ".agents_md_hash"));
    await retireInstructions(root);
    assert.equal(await readFile(file, "utf8"), old + "my rules");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retirement does not follow a symlinked instruction directory", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-instruction-links-"));
  try {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/AGENTS.md"), "preserve");
    await symlink(join(root, "outside"), join(root, "context"));
    assert.equal((await retireInstructions(root)).status, "preserved");
    assert.equal(await readFile(join(root, "outside/AGENTS.md"), "utf8"), "preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});
