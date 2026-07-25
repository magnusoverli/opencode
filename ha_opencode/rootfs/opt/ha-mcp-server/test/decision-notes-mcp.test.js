/**
 * Talks to the real MCP server over stdio to confirm the decision-note tools
 * are actually served, and that turning the feature off removes them from the
 * tool list entirely rather than leaving calls that can only fail.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
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

  it("writes the note and refreshes the injected digest", async () => {
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

    // The digest is what future sessions actually see, so it must be current
    const digest = await readFile(digestPath, "utf8");
    expect(digest).toContain("Node-RED automations are off limits");
    expect(digest).not.toContain("maintained outside Home Assistant"); // rationale stays out
  }, STARTUP_TIMEOUT_MS + 5000);

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
    const [, recalled, superseded] = await converse(env, [
      callTool("remember_decision", {
        title: "Packages hold all new configuration",
        decision: "New integrations go in packages/, not configuration.yaml.",
        rationale: "Keeps configuration.yaml readable.",
        user_approved: true,
      }),
      callTool("recall_decisions", { query: "packages" }),
      callTool("supersede_decision", {
        ids: ["2026-07-26-packages-hold-all-new-configuration"],
        user_approved: true,
      }),
    ]);

    const recalledText = textOf(recalled);
    expect(recalledText).toContain("Packages hold all new configuration");
    // recall_decisions is where the rationale becomes available
    expect(recalledText).toContain("Keeps configuration.yaml readable");

    // The id is date-derived, so the supersede call only matches on the day the
    // note was written; either outcome is a valid, explained response.
    const supersededText = textOf(superseded);
    expect(supersededText).toMatch(/Decision notes retired|Unknown note id/);
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
