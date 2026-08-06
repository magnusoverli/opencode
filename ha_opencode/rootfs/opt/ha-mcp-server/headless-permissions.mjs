#!/usr/bin/env node
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";
import { buildHeadlessPermissionConfig, parseAgentFrontmatter } from "./lib/headless-permissions.js";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? "/data/.config";
const WORKTREE = "/homeassistant";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Could not read ${file}: ${error.message}`);
    return {};
  }
}

async function readAgents(directory, root = directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Could not read ${directory}: ${error.message}`);
    return [];
  }

  const agents = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      agents.push(...(await readAgents(file, root)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    try {
      const agent = parseAgentFrontmatter(await readFile(file, "utf8"));
      if (!agent) continue;
      const name = relative(root, file).replace(/\\/g, "/").replace(/\.md$/, "");
      agents.push({ name, agent });
    } catch (error) {
      console.error(`Could not parse agent ${file}: ${error.message}`);
    }
  }
  return agents;
}

const config = await readJson(join(CONFIG_DIR, "opencode", "config.json"));
const environmentConfig = process.env.OPENCODE_CONFIG_CONTENT
  ? await (async () => {
      try {
        return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
      } catch (error) {
        console.error(`Could not parse OPENCODE_CONFIG_CONTENT: ${error.message}`);
        return {};
      }
    })()
  : {};
const agentRoots = [
  join(CONFIG_DIR, "opencode", "agents"),
  join(CONFIG_DIR, "opencode", "agent"),
  "/homeassistant/.opencode/agents",
  "/homeassistant/.opencode/agent",
  "/data/.opencode/agents",
  "/data/.opencode/agent",
];
const markdownAgents = (await Promise.all(agentRoots.map((root) => readAgents(root)))).flat();

process.stdout.write(JSON.stringify(buildHeadlessPermissionConfig({ config, environmentConfig, markdownAgents, worktree: WORKTREE })));
