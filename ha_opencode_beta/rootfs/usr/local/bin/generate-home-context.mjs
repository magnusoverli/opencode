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
 *   OPENCODE_MCP_TOOL_PROFILE,
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
import { extractSecretValues } from "/opt/ha-mcp-server/lib/context-budget.js";
import {
  DECISION_DIGEST_PATH,
  DECISION_NOTES_DISPLAY_PATH,
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
  // Unique per process: the boot generator and a hand-run `ha-context refresh`
  // can overlap, and a shared temp path would let them corrupt each other.
  const temporary = `${path}.${process.pid}.tmp`;
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
    mcpToolProfile: process.env.OPENCODE_MCP_TOOL_PROFILE || "full",
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

  // The notes file is the user's and is meant to be hand-edited, so the digest
  // is screened as it is built rather than trusting what was written earlier.
  const secretsYaml = await readTextOrNull(`${CONFIG_DIR}/secrets.yaml`);
  const digest = renderDecisionDigest(parsed.notes, {
    secretValues: secretsYaml ? extractSecretValues(secretsYaml) : [],
    // Entries the parser had to skip are still decisions the user made; the
    // digest has to say they are missing rather than imply they never existed.
    unreadable: parsed.rejected,
  });

  // A file that exists but yields nothing readable must not silently remove the
  // digest — this runs at every session start, so that would quietly drop the
  // user's standing context and leave the model believing nothing was decided.
  if (!digest.markdown && !parsed.ok) {
    const notice =
      "# Decision notes\n\n" +
      `\`${DECISION_NOTES_DISPLAY_PATH}\` exists but could not be read (${parsed.errors.length} problem(s)), so ` +
      "the decisions it holds are not available this session. Tell the user, and do not treat this as an absence " +
      "of decisions — offer to help fix the file.\n";
    await writeFileAtomic(DIGEST_OUT, notice);
    log("decisions.yaml is unreadable; wrote a notice instead of removing the digest");
    return;
  }

  if (digest.withheldNotes.length) {
    log(
      `withheld ${digest.withheldNotes.length} note(s) from the session context because they contain ` +
        `credential-shaped text: ${digest.withheldNotes.join(", ")}`,
    );
  }

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

  // At boot there is nothing on disk, so a configuration-only briefing is
  // written immediately and enriched when Core answers. On a manual refresh the
  // existing briefing is usually *better* than what a first pass can produce, so
  // it is left alone until there is something better to replace it with.
  const singlePass = process.env.HOME_CONTEXT_SINGLE_PASS === "true";
  const existing = await readTextOrNull(BRIEFING_OUT);

  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    // Same rule as below: without a token nothing better can be produced, so an
    // existing briefing is worth more than the one this pass could write.
    if (singlePass && existing) {
      log("no Supervisor token; kept the previous briefing rather than replacing it with a configuration-only one");
      return;
    }
    const briefing = await writeBriefing(layout, null);
    log(`briefing written from the configuration directory only (no Supervisor token), ${briefing.bytes} bytes`);
    return;
  }

  if (!singlePass || !existing) {
    const initial = await writeBriefing(layout, null);
    const next = singlePass ? "checking Home Assistant once" : "waiting for Home Assistant";
    log(`briefing written from the configuration directory, ${initial.bytes} bytes; ${next}`);
  }

  const lastAttempt = LIVE_RETRY_SCHEDULE_MS.length - 1;
  for (const [attempt, delayMs] of LIVE_RETRY_SCHEDULE_MS.entries()) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const live = await collectLiveFacts(token);
    if (live.offline) {
      log(`Home Assistant not reachable yet (attempt ${attempt + 1}/${LIVE_RETRY_SCHEDULE_MS.length})`);
      continue;
    }

    // Core reports STARTING until its integrations have finished loading, and a
    // snapshot taken then has entity counts that are simply wrong. Waiting is
    // better than baking a half-loaded picture into every session — but not
    // forever, so the last attempt takes what it can get.
    const state = live.config?.state;
    if (state && state !== "RUNNING" && attempt < lastAttempt) {
      log(`Home Assistant is still starting (state: ${state}); waiting before taking the snapshot`);
      continue;
    }

    const briefing = await writeBriefing(layout, live);
    const missing = live.degraded.length ? ` (missing: ${live.degraded.join(", ")})` : "";
    const partial = state && state !== "RUNNING" ? ` (Core state: ${state})` : "";
    log(`briefing enriched with live Home Assistant data, ${briefing.bytes} bytes${missing}${partial}`);
    return;
  }

  if (singlePass && existing) {
    log("Home Assistant is not reachable; kept the previous briefing rather than replacing it with a poorer one");
    return;
  }
  log("Home Assistant stayed unreachable; keeping the configuration-only briefing");
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // `digest` is the cheap, offline half. Session start runs it on its own so a
  // note the user edited or deleted by hand takes effect at the next session
  // instead of waiting for an add-on restart.
  if (process.env.HOME_CONTEXT_ONLY === "digest") {
    await generateDecisionDigest();
    return;
  }

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
