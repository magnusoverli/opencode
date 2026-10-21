import { constants } from "node:fs";
import { open, mkdir, opendir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseDocument, stringify, visit, isAlias } from "yaml";
import { AGENT_DIRECTORIES, AgentSettingsError, MAX_AGENT_BYTES, MAX_AGENTS, validateAgentConfig, validateAgentId } from "./agents-policy.js";

export const DEFAULT_AGENTS_ROOT = "/data/.config/opencode";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = () => new AgentSettingsError("Agent storage is unavailable or unsafe", 503);
const owner = () => process.getuid?.();

function safe(info, directory) {
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (owner() !== undefined && (info.uid !== owner() || (info.mode & 0o022)))) throw failure();
}

async function directory(name) {
  const file = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    safe(await file.stat(), true);
    // Pin each traversed directory, including intermediate ancestors. A symlink
    // replacement cannot redirect a later read/rename into unrelated root files.
    return { file, name: process.platform === "linux" ? `/proc/self/fd/${file.fd}` : name };
  } catch (error) { await file.close(); throw error; }
}

async function read(parent, name) {
  const file = await open(path.join(parent.name, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    safe(info, false);
    if (info.size > MAX_AGENT_BYTES) throw new AgentSettingsError("Agent file exceeds 64 KiB");
    const buffer = Buffer.alloc(MAX_AGENT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_AGENT_BYTES) throw new AgentSettingsError("Agent file exceeds 64 KiB");
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export function parseAgentFile(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AgentSettingsError("Agent file must contain UTF-8 text"); }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new AgentSettingsError("Agent file requires native V2 YAML frontmatter");
  let config;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    visit(document, (_key, node) => { if (isAlias(node) || node?.tag) throw new Error(); });
    config = document.toJS({ maxAliasCount: 0 });
  } catch { throw new AgentSettingsError("Agent frontmatter is invalid or contains aliases/tags"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new AgentSettingsError("Agent frontmatter must be an object");
  if (config.system !== undefined) throw new AgentSettingsError("Put the agent system prompt in the Markdown body");
  return validateAgentConfig({ ...config, system: match[2].trim() });
}

export function encodeAgentFile(config) {
  const { system = "", ...frontmatter } = validateAgentConfig(config);
  const bytes = Buffer.from(`---\n${stringify(frontmatter)}---\n\n${system}\n`);
  if (bytes.length > MAX_AGENT_BYTES) throw new AgentSettingsError("Agent file exceeds 64 KiB");
  return bytes;
}

export function createAgentStore(root = DEFAULT_AGENTS_ROOT) {
  if (!path.isAbsolute(root)) throw failure();
  async function withRoot(operation, create = false) {
    const opened = [];
    try {
      // The persistent config root already exists in production. Never follow
      // any ancestor symlink, even when callers supply an otherwise safe root.
      const rootPath = path.parse(root).root;
      const first = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let parent = { file: first, name: process.platform === "linux" ? `/proc/self/fd/${first.fd}` : rootPath };
      opened.push(parent);
      for (const part of path.relative(path.parse(root).root, root).split(path.sep).filter(Boolean)) {
        // /tmp and other trusted system ancestors may be shared. The selected
        // config root and every agent subtree below it are checked strictly.
        const nextPath = path.join(parent.name, part);
        let file;
        try { file = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if (error.code !== "ENOENT" || !create) throw error; await mkdir(nextPath, { mode: 0o700 }); file = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
        parent = { file, name: process.platform === "linux" ? `/proc/self/fd/${file.fd}` : nextPath };
        opened.push(parent);
      }
      safe(await parent.file.stat(), true);
      return await operation(parent);
    } finally { for (const entry of opened.reverse()) await entry.file.close(); }
  }

  async function scan() {
    const entries = new Map(), errors = [], seenIds = new Set();
    let count = 0, directories = 0, total = 0;
    const visit = async (parent, prefix, folder) => {
      if (++directories > 256) throw new AgentSettingsError("Too many agent directories");
      const names = [];
      for await (const entry of await opendir(parent.name)) {
        if (names.length === 256) throw new AgentSettingsError("Too many agent directory entries");
        names.push(entry);
      }
      for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = [...prefix, entry.name];
        if (entry.isDirectory() && prefix.length < 3) {
          const child = await directory(path.join(parent.name, entry.name));
          try { await visit(child, relative, folder); } finally { await child.file.close(); }
        } else if (entry.name.endsWith(".md")) {
          if (++count > MAX_AGENTS) throw new AgentSettingsError("Too many agent definitions (maximum 64)");
          const id = [...prefix, entry.name.slice(0, -3)].join("/");
          try {
            validateAgentId(id);
            if (seenIds.has(id)) { entries.delete(id); throw new AgentSettingsError("Duplicate agent definitions"); }
            seenIds.add(id);
            const bytes = await read(parent, entry.name);
            total += bytes.length;
            entries.set(id, { config: parseAgentFile(bytes), path: [folder, ...relative].join("/"), bytes, etag: hash(bytes) });
          } catch (error) { errors.push({ id: /^[a-zA-Z0-9/._-]{1,160}$/.test(id) ? id : "(invalid name)", message: error instanceof AgentSettingsError ? error.message : "Agent file is unreadable or unsafe" }); }
          if (total > 1024 * 1024) throw new AgentSettingsError("Agent definitions exceed 1 MiB");
        } else if (entry.isSymbolicLink()) {
          errors.push({ id: "(unsafe directory)", message: "Agent symlinks are not supported" });
        }
      }
    };
    let located = false;
    try {
      await withRoot(async parent => {
        located = true;
        for (const folder of AGENT_DIRECTORIES) {
          let child;
          try { child = await directory(path.join(parent.name, folder)); }
          catch (error) { if (error.code === "ENOENT") continue; throw failure(); }
          try { await visit(child, [], folder); } finally { await child.file.close(); }
        }
      });
    } catch (error) { if (located || error.code !== "ENOENT") throw error; }
    return { entries, errors };
  }

  // Conditional replacement prevents failed activation rollback from discarding
  // a newer UI/manual edit. All path components remain pinned until rename.
  async function replace(relative, expected, bytes) {
    const parts = relative.split("/");
    if (!AGENT_DIRECTORIES.includes(parts[0]) || !parts.at(-1).endsWith(".md")) throw failure();
    validateAgentId(parts.slice(1).join("/").slice(0, -3));
    return withRoot(async rootDirectory => {
      let parent = rootDirectory;
      const opened = [];
      let temporary;
      try {
        for (const part of parts.slice(0, -1)) {
          try { await mkdir(path.join(parent.name, part), { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
          parent = await directory(path.join(parent.name, part)); opened.push(parent);
        }
        const name = parts.at(-1);
        const matches = async () => {
          try { return hash(await read(parent, name)) === expected; }
          catch (error) { if (error.code === "ENOENT") return expected === null; throw failure(); }
        };
        if (!await matches()) throw new AgentSettingsError("Agent changed concurrently; reload before saving", 409);
        if (bytes === null) {
          if (expected !== null) await unlink(path.join(parent.name, name));
          if (process.platform === "linux") await parent.file.sync();
          return null;
        }
        temporary = `.ha-agent-${randomUUID()}`;
        const file = await open(path.join(parent.name, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        if (!await matches()) throw new AgentSettingsError("Agent changed concurrently; reload before saving", 409);
        await rename(path.join(parent.name, temporary), path.join(parent.name, name)); temporary = undefined;
        if (process.platform === "linux") await parent.file.sync();
        return hash(bytes);
      } finally {
        if (temporary) await unlink(path.join(parent.name, temporary)).catch(() => {});
        for (const entry of opened.reverse()) await entry.file.close();
      }
    }, true);
  }
  return { root, scan, replace };
}
