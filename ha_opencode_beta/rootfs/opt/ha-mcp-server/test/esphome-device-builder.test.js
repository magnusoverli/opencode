import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  DeviceBuilderCommandError,
  ESPHomeDeviceBuilderClient,
  createESPHomeConfig,
  readESPHomeConfig,
  redactESPHomeToolArgs,
  sha256Text,
  updateESPHomeConfig,
  validateConfigurationFilename,
  validateESPHomeConfig,
} from "../lib/esphome-device-builder.js";

const closeables = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => new Promise((resolve) => item.close(resolve))));
});

async function startWebSocketServer(onConnection) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  closeables.push(wss, server);
  wss.on("connection", onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/api/hassio_ingress/session`;
}

function makeFakeClient(initialSource = "esphome:\n  name: kitchen\n") {
  let source = initialSource;
  const calls = [];
  let validate = () => ({ yaml_errors: [], validation_errors: [] });
  const client = {
    calls,
    setValidate(fn) {
      validate = fn;
    },
    async command(command, args = {}) {
      calls.push({ command, args });
      switch (command) {
        case "devices/list":
          return { configured: [{ name: "kitchen", configuration: "kitchen.yaml" }], importable: [] };
        case "devices/get_config":
          return source;
        case "editor/validate_yaml":
          return validate(args.content);
        case "devices/update_config":
          source = args.content;
          return null;
        default:
          throw new Error(`Unexpected command ${command}`);
      }
    },
    getSource() {
      return source;
    },
    setSource(value) {
      source = value;
    },
  };
  return client;
}

describe("ESPHome Device Builder WebSocket client", () => {
  it("preserves the ingress prefix and sends authenticated multiplexed commands", async () => {
    let requestDetails;
    const baseUrl = await startWebSocketServer((socket, request) => {
      requestDetails = request;
      socket.send(JSON.stringify({ server_version: "1.9.2", requires_auth: false }));
      socket.on("message", (raw) => {
        const command = JSON.parse(raw.toString());
        expect(command).toEqual({ command: "devices/get_config", message_id: "1", args: { configuration: "kitchen.yaml" } });
        socket.send(JSON.stringify({ message_id: "unrelated", result: "ignore" }));
        socket.send(JSON.stringify({ message_id: "1", result: null }));
      });
    });

    const client = new ESPHomeDeviceBuilderClient({
      baseUrl,
      ingressSession: "session-value",
      token: "token-value",
    });
    await expect(client.command("devices/get_config", { configuration: "kitchen.yaml" })).resolves.toBeNull();
    expect(requestDetails.url).toBe("/api/hassio_ingress/session/ws");
    expect(requestDetails.headers.cookie).toBe("ingress_session=session-value");
    expect(requestDetails.headers.authorization).toBe("Bearer token-value");
  });

  it("preserves structured command errors without exposing transport credentials", async () => {
    const baseUrl = await startWebSocketServer((socket) => {
      socket.send(JSON.stringify({ server_version: "1.9.2", requires_auth: false }));
      socket.on("message", (raw) => {
        const command = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ message_id: command.message_id, error_code: "not_found", details: "missing config" }));
      });
    });
    const client = new ESPHomeDeviceBuilderClient({ baseUrl, ingressSession: "secret-cookie", token: "secret-token" });

    const error = await client.command("devices/get_config", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(DeviceBuilderCommandError);
    expect(error.code).toBe("not_found");
    expect(error.message).not.toContain("secret-cookie");
    expect(error.message).not.toContain("secret-token");
  });

  it("rejects a WebSocket that is not on the trusted ingress site", async () => {
    const baseUrl = await startWebSocketServer((socket) => {
      socket.send(JSON.stringify({ server_version: "1.9.2", requires_auth: true }));
    });
    const client = new ESPHomeDeviceBuilderClient({ baseUrl });
    await expect(client.command("devices/list")).rejects.toThrow(/did not accept.*ingress session/i);
  });

  it("times out and closes a socket that never sends server info", async () => {
    let closed;
    const socketClosed = new Promise((resolve) => { closed = resolve; });
    const baseUrl = await startWebSocketServer((socket) => socket.on("close", closed));
    const client = new ESPHomeDeviceBuilderClient({ baseUrl, timeoutMs: 20 });
    await expect(client.command("devices/list")).rejects.toThrow(/timed out/);
    await socketClosed;
  });
});

describe("ESPHome source workflow", () => {
  it("reads only active device YAML and returns an integrity hash", async () => {
    const client = makeFakeClient();
    const result = await readESPHomeConfig(client, "kitchen.yaml");
    expect(result.content).toContain("name: kitchen");
    expect(result.sha256).toBe(sha256Text(result.content));
    expect(result.device.configuration).toBe("kitchen.yaml");
  });

  it("rejects paths and secrets", () => {
    expect(() => validateConfigurationFilename("../kitchen.yaml")).toThrow(/filename, not a path/);
    expect(() => validateConfigurationFilename("secrets.yaml")).toThrow(/intentionally unavailable/);
    expect(() => validateConfigurationFilename("kitchen.yml")).toThrow(/end with .yaml/);
  });

  it("validates an in-memory candidate without writing it", async () => {
    const client = makeFakeClient();
    client.setValidate(() => ({ yaml_errors: [{ message: "bad indent" }], validation_errors: [] }));
    const result = await validateESPHomeConfig(client, "kitchen.yaml", "esphome:\n bad: value\n");
    expect(result.valid).toBe(false);
    expect(client.calls.some((call) => call.command === "devices/update_config")).toBe(false);
  });

  it("previews, hash-checks, validates, writes, and verifies an update", async () => {
    const client = makeFakeClient();
    const originalHash = sha256Text(client.getSource());
    const content = "esphome:\n  name: kitchen\nlogger:\n";

    const preview = await updateESPHomeConfig(client, {
      configuration: "kitchen.yaml",
      content,
      expectedSha256: originalHash,
    });
    expect(preview).toMatchObject({ valid: true, applied: false, ready_to_apply: true });
    expect(client.getSource()).not.toBe(content);

    const applied = await updateESPHomeConfig(client, {
      configuration: "kitchen.yaml",
      content,
      expectedSha256: originalHash,
      apply: true,
    });
    expect(applied).toMatchObject({ valid: true, applied: true, previous_sha256: originalHash });
    expect(client.getSource()).toBe(content);
  });

  it("reports manual recovery when persisted validation fails", async () => {
    const client = makeFakeClient();
    const original = client.getSource();
    let validations = 0;
    client.setValidate(() => {
      validations += 1;
      return validations === 1
        ? { yaml_errors: [], validation_errors: [] }
        : { yaml_errors: [], validation_errors: [{ message: "include changed" }] };
    });

    const result = await updateESPHomeConfig(client, {
      configuration: "kitchen.yaml",
      content: "esphome:\n  name: kitchen\nlogger:\n",
      expectedSha256: sha256Text(original),
      apply: true,
    });
    expect(result).toMatchObject({ valid: false, applied: true, post_write_validation_failed: true, manual_recovery_required: true });
    expect(client.getSource()).toContain("logger:");
  });

  it("does not roll back over a newer concurrent edit", async () => {
    const client = makeFakeClient();
    const original = client.getSource();
    const concurrent = "esphome:\n  name: kitchen\n# newer dashboard edit\n";
    let validations = 0;
    client.setValidate(() => {
      validations += 1;
      if (validations === 2) client.setSource(concurrent);
      return validations === 1
        ? { yaml_errors: [], validation_errors: [] }
        : { yaml_errors: [], validation_errors: [{ message: "include changed" }] };
    });

    const result = await updateESPHomeConfig(client, {
      configuration: "kitchen.yaml",
      content: "esphome:\n  name: kitchen\nlogger:\n",
      expectedSha256: sha256Text(original),
      apply: true,
    });
    expect(result).toMatchObject({ valid: false, applied: true, post_write_validation_failed: true, manual_recovery_required: true });
    expect(client.getSource()).toBe(concurrent);
  });

  it("preflights and creates caller-supplied YAML only after apply", async () => {
    let source = null;
    const calls = [];
    const client = {
      async command(command, args = {}) {
        calls.push({ command, args });
        if (command === "devices/list") return { configured: [], importable: [] };
        if (command === "editor/validate_yaml") return { yaml_errors: [], validation_errors: [] };
        if (command === "devices/create") {
          source = args.file_content;
          return { configuration: "garage.yaml" };
        }
        if (command === "devices/get_config") return source;
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const content = "esphome:\n  name: garage\n";
    const preview = await createESPHomeConfig(client, { name: "garage", content });
    expect(preview).toMatchObject({ configuration: "garage.yaml", created: false, ready_to_apply: true });
    expect(calls.some((call) => call.command === "devices/create")).toBe(false);

    const created = await createESPHomeConfig(client, { name: "garage", content, apply: true });
    expect(created).toMatchObject({ configuration: "garage.yaml", created: true, sha256: sha256Text(content) });
  });

  it("rejects unknown boards and passwords without an SSID during create preview", async () => {
    const client = {
      async command(command) {
        if (command === "devices/list") return { configured: [], importable: [] };
        if (command === "boards/get_board") return null;
        throw new Error(`Unexpected command ${command}`);
      },
    };
    await expect(createESPHomeConfig(client, { name: "garage", boardId: "missing" })).rejects.toThrow(/Unknown.*board_id/);
    await expect(createESPHomeConfig(client, { name: "garage", psk: "password" })).rejects.toThrow(/psk requires ssid/);
  });

  it("reports a completed create when post-write validation is unavailable", async () => {
    const content = "esphome:\n  name: garage\n";
    let source = null;
    let validations = 0;
    const client = {
      async command(command, args = {}) {
        if (command === "devices/list") return { configured: [], importable: [] };
        if (command === "editor/validate_yaml") {
          validations += 1;
          if (validations > 1) throw new Error("validator disconnected");
          return { yaml_errors: [], validation_errors: [] };
        }
        if (command === "devices/create") {
          source = args.file_content;
          return { configuration: "garage.yaml" };
        }
        if (command === "devices/get_config") return source;
        throw new Error(`Unexpected command ${command}`);
      },
    };

    const result = await createESPHomeConfig(client, { name: "garage", content, apply: true });
    expect(result).toMatchObject({
      configuration: "garage.yaml",
      created: true,
      post_write_validation_unavailable: true,
      manual_verification_required: true,
    });
  });

  it("redacts YAML and Wi-Fi credentials from generic tool logging", () => {
    const redacted = redactESPHomeToolArgs("esphome_config_create", {
      name: "garage",
      content: "secret yaml",
      ssid: "private-network",
      psk: "private-password",
      apply: true,
    });
    expect(redacted).toEqual({
      name: "garage",
      apply: true,
      content_chars: 11,
      has_ssid: true,
      has_psk: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("private");
    expect(JSON.stringify(redacted)).not.toContain("secret yaml");
  });
});
