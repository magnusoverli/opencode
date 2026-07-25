#!/usr/bin/env node
/**
 * Generate the context files the add-on injects into OpenCode's prompt.
 *
 *   /data/context/home-briefing.md   what this Home Assistant installation is
 *   /data/context/decision-notes.md  digest of the user's active decision notes
 *
 * Run detached from `init-opencode` so add-on start-up never waits on Home
 * Assistant, and again on demand from `ha-context refresh`.
 *
 * The briefing is written in two passes. The filesystem scan works whether or
 * not Core is up, so it is written immediately; the parts that need a running
 * Home Assistant are retried in the background and the file is rewritten once
 * they arrive. Core is frequently still starting when the add-on does, and a
 * partial briefing beats no briefing.
 *
 * Environment:
 *   SUPERVISOR_TOKEN               required for anything live
 *   OPENCODE_HOME_BRIEFING         "true" to generate the briefing
 *   OPENCODE_DECISION_NOTES        "true" to render the notes digest
 *   OPENCODE_ADDON_ACCESS_ENABLED, SCREENSHOT_ENABLED, OPENCODE_MCP_ENABLED,
 *   OPENCODE_LSP_ENABLED, OPENCODE_RESTRICT_SENSITIVE_FILES, Z2M_URL
 *                                  reported under "Add-on capabilities"
 *   HOME_CONTEXT_SINGLE_PASS       "true" to try Home Assistant once instead of
 *                                  retrying (used by `ha-context refresh`)
 *   HOME_CONTEXT_CONFIG_DIR        override the configuration directory to scan
 *   HOME_CONTEXT_OUTPUT_DIR        override where the context files are written
 *   HOME_CONTEXT_NOTES_PATH        override the decision-notes source file
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { dirname } from "path";

import { buildBriefingFacts, scanConfigLayout, DEFAULT_CONFIG_DIR } from "/opt/ha-mcp-server/lib/home-facts.js";
import { CONTEXT_DIR, HOME_BRIEFING_PATH, renderHomeBriefing } from "/opt/ha-mcp-server/lib/home-briefing.js";
import { collectLiveFacts } from "/opt/ha-mcp-server/lib/ha-live.js";
import {
  DECISION_DIGEST_PATH,
  DECISION_NOTES_PATH,
  parseDecisionNotes,
  renderDecisionDigest,
} from "/opt/ha-mcp-server/lib/decision-notes.js";

const FS_API = { readFile, readdir, stat };

/**
 * Locations, overridable so the generator can be pointed at a copy when
 * debugging or tested without a live Home Assistant configuration directory.
 */
const CONFIG_DIR = process.env.HOME_CONTEXT_CONFIG_DIR || DEFAULT_CONFIG_DIR;
const OUTPUT_DIR = process.env.HOME_CONTEXT_OUTPUT_DIR || CONTEXT_DIR;
const BRIEFING_OUT = process.env.HOME_CONTEXT_OUTPUT_DIR
  ? `${OUTPUT_DIR}/home-briefing.md`
  : HOME_BRIEFING_PATH;
const DIGEST_OUT = process.env.HOME_CONTEXT_OUTPUT_DIR
  ? `${OUTPUT_DIR}/decision-notes.md`
  : DECISION_DIGEST_PATH;
const NOTES_IN = process.env.HOME_CONTEXT_NOTES_PATH || DECISION_NOTES_PATH;

/**
 * How long to keep waiting for Home Assistant to finish starting.
 *
 * At boot the add-on and Core come up together, so it is worth waiting minutes.
 * When a user runs `ha-context refresh` by hand, Core is either up or it is
 * not — blocking their terminal for two minutes to find out is not.
 */
const LIVE_RETRY_SCHEDULE_MS =
  process.env.HOME_CONTEXT_SINGLE_PASS === "true" ? [0] : [0, 15000, 30000, 60000, 60000];

const flag = (name) => process.env[name] === "true";

function log(message) {
  console.log(`[home-context] ${message}`);
}

async function writeFileAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, "utf8");
  // Rename is atomic on the same filesystem, so a reader never sees a partial
  // file — OpenCode may read these at any moment.
  await rename(temporary, path);
}

async function removeIfPresent(path) {
  await rm(path, { force: true });
}

function addonCapabilities() {
  return {
    mcp: flag("OPENCODE_MCP_ENABLED"),
    lsp: flag("OPENCODE_LSP_ENABLED"),
    screenshot: flag("SCREENSHOT_ENABLED"),
    addonAccess: flag("OPENCODE_ADDON_ACCESS_ENABLED"),
    restrictSensitiveFiles: flag("OPENCODE_RESTRICT_SENSITIVE_FILES"),
  };
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Render the decision-notes digest from the user's file.
 *
 * Offline and cheap, so it runs before the briefing and again is never allowed
 * to fail the whole generator.
 */
async function generateDecisionDigest() {
  if (!flag("OPENCODE_DECISION_NOTES")) {
    await removeIfPresent(DIGEST_OUT);
    return;
  }

  const source = await readTextOrNull(NOTES_IN);
  if (source === null) {
    // No notes recorded yet — nothing to inject, and no empty file to explain.
    await removeIfPresent(DIGEST_OUT);
    return;
  }

  const parsed = parseDecisionNotes(source);
  if (!parsed.ok) {
    log(`decisions.yaml could not be fully parsed (${parsed.errors.length} problem(s)); using the notes that are readable`);
  }

  const digest = renderDecisionDigest(parsed.notes);
  if (!digest.markdown) {
    await removeIfPresent(DIGEST_OUT);
    return;
  }

  await writeFileAtomic(DIGEST_OUT, digest.markdown);
  log(`decision notes digest: ${digest.includedNotes.length} active note(s), ${digest.bytes} bytes`);
}

async function writeBriefing(layout, live) {
  const facts = buildBriefingFacts({
    generatedAt: new Date().toISOString(),
    layout,
    live,
    addon: addonCapabilities(),
    z2mConfigured: Boolean(process.env.Z2M_URL),
  });

  const briefing = renderHomeBriefing(facts);
  await writeFileAtomic(BRIEFING_OUT, briefing.markdown);
  return briefing;
}

async function generateBriefing() {
  if (!flag("OPENCODE_HOME_BRIEFING")) {
    await removeIfPresent(BRIEFING_OUT);
    return;
  }

  const layout = await scanConfigLayout(FS_API, CONFIG_DIR);

  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    const briefing = await writeBriefing(layout, null);
    log(`briefing written from the configuration directory only (no Supervisor token), ${briefing.bytes} bytes`);
    return;
  }

  // First pass: something useful on disk immediately.
  const initial = await writeBriefing(layout, null);
  log(`briefing written from the configuration directory, ${initial.bytes} bytes; waiting for Home Assistant`);

  for (const [attempt, delayMs] of LIVE_RETRY_SCHEDULE_MS.entries()) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const live = await collectLiveFacts(token);
    if (live.offline) {
      log(`Home Assistant not reachable yet (attempt ${attempt + 1}/${LIVE_RETRY_SCHEDULE_MS.length})`);
      continue;
    }

    const briefing = await writeBriefing(layout, live);
    const missing = live.degraded.length ? ` (missing: ${live.degraded.join(", ")})` : "";
    log(`briefing enriched with live Home Assistant data, ${briefing.bytes} bytes${missing}`);
    return;
  }

  log("Home Assistant stayed unreachable; keeping the configuration-only briefing");
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Independent artifacts: a failure in one must not take out the other.
  const results = await Promise.allSettled([generateDecisionDigest(), generateBriefing()]);
  for (const result of results) {
    if (result.status === "rejected") log(`error: ${result.reason?.message ?? result.reason}`);
  }
}

main().catch((error) => {
  log(`fatal: ${error?.message ?? error}`);
  process.exitCode = 1;
});
