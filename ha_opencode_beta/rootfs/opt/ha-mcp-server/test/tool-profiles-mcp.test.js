import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const TIMEOUT_MS = 20000;
const children = new Set();

afterAll(() => {
  for (const child of children) child.kill();
});

function request(profile, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        OPENCODE_MCP_TOOL_PROFILE: profile,
        OPENCODE_DECISION_NOTES: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let buffer = "";
    const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for MCP response")), TIMEOUT_MS);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      children.delete(child);
      child.kill();
      callback(value);
    };

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
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, ...request })}\n`);
        } else if (message.id === 2) {
          finish(resolve, message.result ?? message.error);
        }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
    })}\n`);
  });
}

describe("MCP tool-profile enforcement", () => {
  it("advertises only scoped tools and rejects a hidden tool before dispatch", async () => {
    const compact = await request("compact", { method: "tools/list", params: {} });
    const compactNames = compact.tools.map((tool) => tool.name);
    expect(compactNames).toContain("get_home_context");
    expect(compactNames).not.toContain("call_service");
    expect(compactNames).not.toContain("write_config_safe");
    expect(compactNames).not.toContain("hab_run");

    const rejected = await request("compact", {
      method: "tools/call",
      params: { name: "call_service", arguments: { domain: "light", service: "turn_on" } },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("compact MCP tool profile");

    const configuration = await request("configuration", { method: "tools/list", params: {} });
    const configurationNames = configuration.tools.map((tool) => tool.name);
    expect(configurationNames).toContain("write_config_safe");
    expect(configurationNames).not.toContain("call_service");
    expect(configurationNames).not.toContain("hab_run");
  }, TIMEOUT_MS + 5000);
});
