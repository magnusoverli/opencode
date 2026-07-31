/**
 * Talks to the real MCP server over stdio to confirm the decision-note tools
 * are actually served, and that turning the feature off removes them from the
 * tool list entirely rather than leaving calls that can only fail.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const STARTUP_TIMEOUT_MS = 20000;

const scratchDirs = [];

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "decision-notes-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Drive a short JSON-RPC conversation: initialize, then the given requests in
 * order, resolving with the results keyed by request id.
 */
function converse(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SUPERVISOR_TOKEN: "test-token", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = new Map();
    let buffer = "";
    let settled = false;
    let pending = 0;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(value);
    };

    const timer = setTimeout(() => finish(reject, new Error("timed out")), STARTUP_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          requests.forEach((request, index) => {
            pending += 1;
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, ...request })}\n`);
          });
        } else if (message.id >= 2) {
          results.set(message.id - 2, message.result ?? message.error);
          pending -= 1;
          if (pending === 0) finish(resolve, requests.map((_, index) => results.get(index)));
        }
      }
    });

    child.on("error", (error) => finish(reject, error));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      })}\n`,
    );
  });
}

const callTool = (name, args) => ({ method: "tools/call", params: { name, arguments: args } });
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");

/**
 * Run one initialize + tools/list exchange against a freshly spawned server.
 *
 * @param {Record<string, string>} env
 * @returns {Promise<string[]>} tool names
 */
function listTools(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SUPERVISOR_TOKEN: "test-token", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error("timed out waiting for tools/list")),
      STARTUP_TIMEOUT_MS,
    );

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC frame
        }

        if (message.id === 1) {
          // Initialized: ask for the tool list.
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } else if (message.id === 2) {
          finish(resolve, (message.result?.tools ?? []).map((tool) => tool.name));
        }
      }
    });

    child.on("error", (error) => finish(reject, error));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      })}\n`,
    );
  });
}

describe("decision-note MCP tools", () => {
  it("serves all three tools when the feature is on", async () => {
    const tools = await listTools({ OPENCODE_DECISION_NOTES: "true" });
    expect(tools).toContain("remember_decision");
    expect(tools).toContain("recall_decisions");
    expect(tools).toContain("supersede_decision");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("does not advertise them when the feature is off", async () => {
    const tools = await listTools({ OPENCODE_DECISION_NOTES: "false" });
    expect(tools).not.toContain("remember_decision");
    expect(tools).not.toContain("recall_decisions");
    expect(tools).not.toContain("supersede_decision");
    // The rest of the surface is untouched
    expect(tools).toContain("get_states");
    expect(tools).toContain("write_config_safe");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("keeps every tool name unique", async () => {
    const tools = await listTools({ OPENCODE_DECISION_NOTES: "true" });
    expect(new Set(tools).size).toBe(tools.length);
  }, STARTUP_TIMEOUT_MS + 5000);
});

describe("recording a decision end to end", () => {
  let notesDir;
  let digestPath;
  let env;

  beforeEach(async () => {
    notesDir = await scratch();
    digestPath = join(notesDir, "digest.md");
    env = {
      OPENCODE_DECISION_NOTES: "true",
      OPENCODE_DECISION_NOTES_DIR: notesDir,
      OPENCODE_DECISION_DIGEST_PATH: digestPath,
    };
  });

  it("writes the note without touching the injected digest", async () => {
    // Pre-seed the digest so "unchanged" is a real assertion rather than one
    // that passes on a file nothing ever created.
    const before = "# Decision notes\n\nAn earlier digest that must survive.\n";
    await writeFile(digestPath, before, "utf8");

    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Node-RED automations are off limits",
        decision: "Do not migrate or edit the Node-RED flows.",
        rationale: "They are maintained outside Home Assistant.",
        user_approved: true,
      }),
    ]);

    expect(textOf(recorded)).toContain("Decision recorded");
    expect(recorded.isError).toBeFalsy();

    const stored = await readFile(join(notesDir, "decisions.yaml"), "utf8");
    expect(stored).toContain("Node-RED automations are off limits");

    // The digest sits in OpenCode's `instructions` and is re-read on every
    // request. Rewriting it here would edit the system prompt underneath a
    // live session and throw away the cached prefix, so recording a note must
    // leave it exactly as it was — the generator owns this file.
    expect(await readFile(digestPath, "utf8")).toBe(before);

    // The user still has to be told when the note reaches the standing context.
    expect(textOf(recorded)).toContain("ha-context refresh");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("does not delete the injected digest when the last note is superseded", async () => {
    const before = "# Decision notes\n\nAn earlier digest that must survive.\n";

    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Only note",
        decision: "This is the single active note.",
        user_approved: true,
      }),
    ]);
    // Ids are date-derived, so it has to come from the response.
    const id = textOf(recorded).match(/as `([^`]+)`/)?.[1];
    expect(id).toBeTruthy();

    await writeFile(digestPath, before, "utf8");

    const [retired] = await converse(env, [
      callTool("supersede_decision", { ids: [id], user_approved: true }),
    ]);
    expect(retired.isError).toBeFalsy();

    // Superseding the last active note used to unlink the digest, which removes
    // a whole block from the system prompt mid-session.
    expect(await readFile(digestPath, "utf8")).toBe(before);
  }, (STARTUP_TIMEOUT_MS + 5000) * 2);

  it("refuses to write anything without explicit user approval", async () => {
    const [result] = await converse(env, [
      callTool("remember_decision", { title: "Sneaky", decision: "Recorded without asking.", user_approved: false }),
    ]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("user_approved");
    await expect(readFile(join(notesDir, "decisions.yaml"), "utf8")).rejects.toThrow();
  }, STARTUP_TIMEOUT_MS + 5000);

  it("reports no notes rather than failing on a fresh installation", async () => {
    const [result] = await converse(env, [callTool("recall_decisions", {})]);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No decision notes have been recorded");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("records, recalls, and supersedes across calls", async () => {
    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Packages hold all new configuration",
        decision: "New integrations go in packages/, not configuration.yaml.",
        rationale: "Keeps configuration.yaml readable.",
        user_approved: true,
      }),
    ]);

    // Ids are date-derived, so the id has to come from the response. Hard-coding
    // one makes the supersede below succeed through its "unknown id" branch on
    // every day but the one the test was written.
    const recordedId = textOf(recorded).match(/as `([^`]+)`/)?.[1];
    expect(recordedId).toBeTruthy();

    const [recalled, superseded] = await converse(env, [
      callTool("recall_decisions", { query: "packages" }),
      callTool("supersede_decision", { ids: [recordedId], user_approved: true }),
    ]);

    const recalledText = textOf(recalled);
    expect(recalledText).toContain("Packages hold all new configuration");
    // recall_decisions is where the rationale becomes available
    expect(recalledText).toContain("Keeps configuration.yaml readable");

    const supersededText = textOf(superseded);
    expect(superseded.isError).toBeFalsy();
    expect(supersededText).toContain("Decision notes retired");
    expect(supersededText).toContain(recordedId);
  }, STARTUP_TIMEOUT_MS + 5000);

  it("tells the user which query missed rather than implying nothing was decided", async () => {
    const [, missed] = await converse(env, [
      callTool("remember_decision", {
        title: "TC71 privacy toggle is inverted",
        decision: "switch.tc71_privacy_mode inverts switch.tc71_cam_1 on purpose.",
        user_approved: true,
      }),
      callTool("recall_decisions", { query: "dishwasher rinse aid" }),
    ]);

    const text = textOf(missed);
    expect(text).toContain("No note matched that query");
    expect(text).toContain("1 active note");
    expect(text).toContain("without a `query`");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("finds a note from a plain question", async () => {
    const [, recalled] = await converse(env, [
      callTool("remember_decision", {
        title: "TC71 privacy toggle is inverted",
        decision: "switch.tc71_privacy_mode inverts switch.tc71_cam_1 so ON means privacy engaged.",
        rationale: "Matches the Tapo app.",
        entities: ["switch.tc71_cam_1"],
        user_approved: true,
      }),
      callTool("recall_decisions", { query: "why is the camera privacy toggle backwards" }),
    ]);

    expect(textOf(recalled)).toContain("TC71 privacy toggle is inverted");
  }, STARTUP_TIMEOUT_MS + 5000);

  // "Nothing was ever recorded" is the one sentence that must never be said
  // while the file holds decisions — retired ones included.
  it("does not claim nothing was recorded when every note is superseded", async () => {
    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Old approach to the heating schedule",
        decision: "Use the thermostat schedule, not automations.",
        user_approved: true,
      }),
    ]);
    const id = textOf(recorded).match(/as `([^`]+)`/)?.[1];

    const [, recalled] = await converse(env, [
      callTool("supersede_decision", { ids: [id], user_approved: true }),
      callTool("recall_decisions", {}),
    ]);

    const text = textOf(recalled);
    expect(text).not.toContain("No decision notes have been recorded");
    expect(text).toContain("1 recorded note");
    expect(text).toContain("include_superseded");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("records a pin and reports it", async () => {
    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Z-Wave stick was retired deliberately",
        decision: "Do not re-add the Z-Wave integration.",
        pin: true,
        user_approved: true,
      }),
    ]);

    expect(recorded.isError).toBeFalsy();
    expect(textOf(recorded)).toContain("(pinned)");
    expect(await readFile(join(notesDir, "decisions.yaml"), "utf8")).toContain("pin: true");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("states digest coverage when recording", async () => {
    const [recorded] = await converse(env, [
      callTool("remember_decision", {
        title: "Packages hold all new configuration",
        decision: "New integrations go in packages/.",
        user_approved: true,
      }),
    ]);

    expect(textOf(recorded)).toContain("fit the session digest");
  }, STARTUP_TIMEOUT_MS + 5000);

  it("rejects a note containing a credential", async () => {
    const [result] = await converse(env, [
      callTool("remember_decision", {
        title: "Broker access",
        decision: "The broker password is hunter2hunter2 for the admin user.",
        user_approved: true,
      }),
    ]);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("credentials must not go in them");
    expect(text).not.toContain("hunter2hunter2");
  }, STARTUP_TIMEOUT_MS + 5000);
});
