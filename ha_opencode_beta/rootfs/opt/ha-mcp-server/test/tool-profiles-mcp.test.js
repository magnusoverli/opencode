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

// Every tool the compact profile must omit. This is the list the read-only
// session (`ha-readonly`) leans on: the profile is what makes that session
// read-only on the Home Assistant side, so a tool slipping back into compact is
// a real capability leak, not a cosmetic regression.
const MUTATING_TOOLS = [
  { name: "call_service", arguments: { domain: "light", service: "turn_on" } },
  { name: "fire_event", arguments: { event_type: "test_event" } },
  { name: "write_config_safe", arguments: { file_path: "automations.yaml", content: "[]" } },
  { name: "check_config_syntax", arguments: { content: "{}" } },
  { name: "validate_config", arguments: {} },
  { name: "update_component", arguments: { component: "core" } },
  { name: "watch_firmware_update", arguments: { entity_id: "update.device" } },
  { name: "esphome_upload", arguments: { device: "sensor" } },
  { name: "esphome_config_update", arguments: { configuration: "sensor.yaml", content: "esphome:\n  name: sensor\n", expected_sha256: "0".repeat(64), apply: true } },
  { name: "esphome_config_create", arguments: { name: "sensor", apply: true } },
  { name: "hab_run", arguments: { args: ["entity", "list"] } },
  { name: "zigporter_run", arguments: { args: ["list-devices"] } },
  { name: "screenshot_url", arguments: { url: "http://homeassistant.local:8123/" } },
  { name: "remember_decision", arguments: { decision: "x", user_approved: true } },
];

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
    expect(configurationNames).toContain("esphome_list_devices");
    expect(configurationNames).toContain("esphome_config_read");
    expect(configurationNames).toContain("esphome_config_validate");
    expect(configurationNames).toContain("esphome_config_update");
    expect(configurationNames).toContain("esphome_config_create");
    expect(configurationNames).not.toContain("call_service");
    expect(configurationNames).not.toContain("hab_run");
  }, TIMEOUT_MS + 5000);

  it("hides every mutating tool from the compact profile's tool list", async () => {
    const compact = await request("compact", { method: "tools/list", params: {} });
    const compactNames = new Set(compact.tools.map((tool) => tool.name));
    for (const { name } of MUTATING_TOOLS) {
      expect(compactNames.has(name), `${name} is advertised in the compact profile`).toBe(false);
    }
    // The read-only work still has to be possible.
    for (const name of ["get_states", "get_history", "get_logbook", "diagnose_entity", "get_error_log"]) {
      expect(compactNames.has(name), `${name} is missing from the compact profile`).toBe(true);
    }
  }, TIMEOUT_MS + 5000);

  it.each(MUTATING_TOOLS)(
    "rejects $name at dispatch in the compact profile",
    async ({ name, arguments: args }) => {
      const rejected = await request("compact", {
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(rejected.isError, `${name} was not rejected`).toBe(true);
      // A client with a stale tool list gets an explanation, not a side effect.
      expect(rejected.content[0].text).toMatch(/not available in this add-on configuration|compact MCP tool profile/);
    },
    TIMEOUT_MS + 5000,
  );
});
