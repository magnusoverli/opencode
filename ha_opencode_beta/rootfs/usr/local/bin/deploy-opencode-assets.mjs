#!/usr/bin/env node
/**
 * Deploy the add-on's skills into OpenCode's global discovery path.
 *
 * OpenCode finds skills by convention under its global config directory
 * (XDG_CONFIG_HOME/opencode), not from anything we can point at, so the files
 * have to exist there. They ship read-only inside the image and are copied into
 * /data at every start.
 *
 * The read-only agent is deliberately NOT deployed here. An agent file in the
 * global directory is selectable in every session, including OpenChamber, where
 * nothing applies the read-only configuration overlay — its `edit`/`bash` denials
 * would hold but the Home Assistant MCP server would still be in whatever
 * profile the user configured, so `call_service` and `write_config_safe` would
 * work in a session whose own description promises they do not. That agent
 * exists only inside `ha-readonly`, which is the one place the whole contract
 * is in force.
 *
 * The hard part is updates. These are the add-on's files, but they sit in a
 * directory the user can edit, and editing them is a reasonable thing to do —
 * so a refresh must never overwrite work someone did by hand. Every deployed
 * file's digest is recorded when it is written. On the next start:
 *
 *   - target missing                 -> deploy it
 *   - target matches what we wrote   -> refresh it from the image
 *   - target differs                 -> leave it alone and warn
 *
 * The same rule governs removal: an asset dropped from the image is deleted
 * only if it is still byte-for-byte what this add-on last wrote.
 *
 * Never throws and always exits 0. This runs from the init oneshot, and the
 * base image takes the whole container down when a oneshot fails — optional
 * guidance files do not get a vote on whether the add-on boots.
 */

import { createHash } from "crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { dirname, join, relative, sep } from "path";

const SOURCE_ROOT = process.env.OPENCODE_ASSETS_SOURCE || "/opt/ha-mcp-server";
const TARGET_ROOT = process.env.OPENCODE_ASSETS_TARGET || "/data/.config/opencode";
const STATE_FILE = process.env.OPENCODE_ASSETS_STATE || "/data/.opencode_managed_assets.json";

/**
 * Which trees are deployed, image path -> global-config path. The name is
 * OpenCode's, not ours: it scans `skills/<name>/SKILL.md` under the global
 * config directory.
 */
const ASSET_TREES = [
  { source: "skills", target: "skills" },
];

const log = (message) => console.log(message);
// The init service reads this prefix and routes the line through
// bashio::log.warning, so "your edits stopped an update" is not buried among
// routine start-up chatter.
const warn = (message) => console.log(`[warning] ${message}`);

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/** Every file under `dir`, as paths relative to it, with `/` separators. */
async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // parentPath is Node 20.12+/22+; path is the older name for the same thing.
    const parent = entry.parentPath ?? entry.path ?? dir;
    files.push(relative(dir, join(parent, entry.name)).split(sep).join("/"));
  }
  return files.sort();
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object"
      ? parsed.files
      : {};
  } catch {
    return {};
  }
}

async function writeState(files) {
  const payload = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, payload, "utf8");
}

async function digestOfFile(path) {
  try {
    return digest(await readFile(path));
  } catch {
    return null;
  }
}

async function deployTree(tree, previous, next, counters) {
  const sourceDir = join(SOURCE_ROOT, tree.source);
  const targetDir = join(TARGET_ROOT, tree.target);

  const sourceFiles = await listFiles(sourceDir);
  if (sourceFiles.length === 0) {
    log(`No ${tree.source} to deploy (${sourceDir} is empty or missing)`);
  } else {
    await mkdir(targetDir, { recursive: true });
  }

  for (const relativePath of sourceFiles) {
    const key = `${tree.target}/${relativePath}`;
    const sourcePath = join(sourceDir, relativePath);
    const targetPath = join(targetDir, relativePath);

    const sourceDigest = await digestOfFile(sourcePath);
    if (sourceDigest === null) continue;

    const targetDigest = await digestOfFile(targetPath);
    const recordedDigest = previous[key];

    if (targetDigest === null) {
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath);
      next[key] = sourceDigest;
      counters.deployed += 1;
      continue;
    }

    if (targetDigest === sourceDigest) {
      next[key] = sourceDigest;
      counters.current += 1;
      continue;
    }

    if (recordedDigest && recordedDigest === targetDigest) {
      await cp(sourcePath, targetPath);
      next[key] = sourceDigest;
      counters.updated += 1;
      continue;
    }

    // Either the user edited it, or it predates this bookkeeping and we cannot
    // tell an edit from a stale copy. Both are kept: losing someone's edits is
    // far worse than shipping guidance one release behind.
    //
    // The record keeps pointing at what the ADD-ON last wrote, never at the
    // user's version. Recording the edited digest would make the next start
    // read it back as "this is ours" and overwrite the edits after all — the
    // exact loss this branch exists to prevent.
    if (recordedDigest) next[key] = recordedDigest;
    counters.preserved += 1;
    warn(`Keeping your edited ${key} - the add-on's newer version was not applied`);
  }

  // Assets this add-on deployed and has since dropped from the image.
  const sourceKeys = new Set(sourceFiles.map((file) => `${tree.target}/${file}`));
  for (const key of Object.keys(previous)) {
    if (!key.startsWith(`${tree.target}/`) || sourceKeys.has(key)) continue;
    const targetPath = join(TARGET_ROOT, key);
    const targetDigest = await digestOfFile(targetPath);
    if (targetDigest === null) continue;
    if (targetDigest !== previous[key]) {
      // Edited, so it is the user's file now even though we put it there. The
      // add-on stops tracking it: there is no image copy left to compare
      // against, and saying this once is enough.
      counters.preserved += 1;
      warn(`Keeping your edited ${key} - it is no longer shipped by the add-on`);
      continue;
    }
    await rm(targetPath, { force: true });
    counters.removed += 1;
  }
}

async function pruneEmptyDirectories(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    await pruneEmptyDirectories(child);
    try {
      if ((await readdir(child)).length === 0) await rm(child, { recursive: true, force: true });
    } catch {
      /* a directory we cannot read is not ours to remove */
    }
  }
}

async function main() {
  const previous = await readState();
  const next = {};
  const counters = { deployed: 0, updated: 0, current: 0, preserved: 0, removed: 0 };

  for (const tree of ASSET_TREES) {
    await deployTree(tree, previous, next, counters);
  }

  for (const tree of ASSET_TREES) {
    await pruneEmptyDirectories(join(TARGET_ROOT, tree.target));
  }

  await writeState(next);

  const parts = [
    `${counters.deployed} deployed`,
    `${counters.updated} updated`,
    `${counters.current} already current`,
  ];
  if (counters.preserved > 0) parts.push(`${counters.preserved} kept (edited)`);
  if (counters.removed > 0) parts.push(`${counters.removed} removed`);
  log(`Skills: ${parts.join(", ")}`);
}

try {
  await stat(SOURCE_ROOT);
  await main();
} catch (error) {
  log(`Could not deploy skills and agents: ${error?.message ?? error}`);
}
