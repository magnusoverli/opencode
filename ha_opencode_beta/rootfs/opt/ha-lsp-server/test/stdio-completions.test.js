import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

let child;
let connection;
let sequence = 0;
beforeAll(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url)), "--stdio"], {
    env: { ...process.env, SUPERVISOR_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  connection.onNotification("window/logMessage", () => {});
  connection.onNotification("textDocument/publishDiagnostics", () => {});
  connection.listen();
  await connection.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
  await connection.sendNotification("initialized", {});
});
afterAll(async () => {
  try {
    await connection?.sendRequest("shutdown");
    await connection?.sendNotification("exit");
  } finally {
    connection?.dispose();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    }
  }
});
async function complete(text) {
  const uri = `file:///tmp/ha-lsp-in-memory-${sequence++}.yaml`;
  await connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "yaml", version: 1, text } });
  const lines = text.split("\n");
  const result = await connection.sendRequest("textDocument/completion", {
    textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length },
  });
  await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  return result.map((item) => item.label);
}
describe("real LSP completion protocol without HA credentials", () => {
  it.each(["value: !include /etc/passwd", "value: !include secrets.yml", "value: !secret example"])(
    "never returns a sensitive definition for %j", async (text) => {
      const uri = `file:///homeassistant/lsp-definition-${sequence++}.yaml`;
      await connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "yaml", version: 1, text } });
      try {
        const result = await connection.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 15 } });
        expect(result).toBeNull();
      } finally {
        await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
      }
    });
  it.each([
    "triggers:\n  - trigger: ",
    "triggers:\n- trigger: ",
    "trigger:\n  - platform: ",
    "trigger:\n- platform: ",
    "automation:\n  - alias: Modern\n    triggers:\n      - trigger: ",
  ])("offers trigger types for %j", async (text) => {
    expect(await complete(text)).toEqual(expect.arrayContaining(["state", "numeric_state", "time"]));
  });
  it("offers modern trigger and action mapping keys", async () => {
    expect(await complete("triggers:\n  - ")).toEqual(expect.arrayContaining(["trigger", "entity_id"]));
    expect(await complete("actions:\n  - ")).toEqual(expect.arrayContaining(["action", "target"]));
  });
  it("does not treat unrelated platform values as automation triggers", async () => {
    expect(await complete("sensor:\n  - platform: ")).not.toContain("numeric_state");
  });
});
