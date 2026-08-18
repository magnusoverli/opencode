import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  DeviceBuilderCommandError,
  ESPHomeDeviceBuilderClient,
  createESPHomeConfig,
  readESPHomeConfig,
  redactESPHomeToolArgs,
  maskESPHomeSensitiveText,
  restoreESPHomeSensitivePlaceholders,
  sanitizeESPHomeResult,
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

  it("collects bounded stream events and stops a long-running stream", async () => {
    let originalMessageId;
    const baseUrl = await startWebSocketServer((socket) => {
      socket.send(JSON.stringify({ server_version: "1.9.2", requires_auth: false }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.command === "devices/logs") {
          originalMessageId = message.message_id;
          socket.send(JSON.stringify({ message_id: originalMessageId, event: "output", data: "line one" }));
          socket.send(JSON.stringify({ message_id: originalMessageId, event: "output", data: "line two" }));
          socket.send(JSON.stringify({ message_id: originalMessageId, event: "output", data: "line three" }));
        } else if (message.command === "devices/stop_stream") {
          expect(message.args).toEqual({ stream_id: originalMessageId });
          socket.send(JSON.stringify({ message_id: message.message_id, result: { cancelled: true } }));
        }
      });
    });
    const client = new ESPHomeDeviceBuilderClient({ baseUrl });
    const result = await client.stream("devices/logs", { configuration: "kitchen.yaml" }, {
      timeoutMs: 5000,
      maxEvents: 2,
      maxChars: 100,
      stopCommand: "devices/stop_stream",
    });
    expect(result).toMatchObject({ truncated: true, stopReason: "event_limit" });
    expect(result.events).toEqual([
      { event: "output", data: "line one" },
      { event: "output", data: "line two" },
    ]);
  });

  it("forces a stream closed when stop acknowledgement never arrives", async () => {
    const baseUrl = await startWebSocketServer((socket) => {
      socket.send(JSON.stringify({ server_version: "1.9.2", requires_auth: false }));
      socket.on("message", () => {});
    });
    const client = new ESPHomeDeviceBuilderClient({ baseUrl });
    const started = Date.now();
    const result = await client.stream("devices/logs", { configuration: "kitchen.yaml" }, {
      timeoutMs: 20,
      stopGraceMs: 20,
      stopCommand: "devices/stop_stream",
    });
    expect(result).toMatchObject({ truncated: true, stopReason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
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
    expect(validateConfigurationFilename("kitchen.yml")).toBe("kitchen.yml");
    expect(() => validateConfigurationFilename("kitchen.json")).toThrow(/end with .yaml or .yml/);
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

  it("round-trips sensitive YAML through opaque placeholders", () => {
    const source = "api:\n  encryption:\n    key: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\nwifi:\n  password: super-secret\n";
    const masked = maskESPHomeSensitiveText(source);
    expect(masked.content).not.toContain("AQEBAQ");
    expect(masked.content).not.toContain("super-secret");
    expect(masked.content).not.toContain(sha256Text("super-secret").slice(0, 12));
    expect(masked.replacements.size).toBe(2);
    expect(restoreESPHomeSensitivePlaceholders(`${masked.content}logger:\n`, source)).toBe(`${source}logger:\n`);
  });

  it("masks common, multiline, nested-result, and known secret representations", () => {
    const source = "substitutions:\n  wifi_password: |2-\n    line-one\n    line-two\n  client_secret: \"quoted#value\"\n";
    const masked = maskESPHomeSensitiveText(source);
    expect(masked.content).not.toContain("line-one");
    expect(masked.content).not.toContain("line-two");
    expect(masked.content).not.toContain("quoted#value");
    expect(restoreESPHomeSensitivePlaceholders(masked.content, source)).toBe(source);

    const flowSource = "wifi: {password: \"flow#secret\"}\n";
    const flowMasked = maskESPHomeSensitiveText(flowSource);
    expect(flowMasked.content).not.toContain("flow#secret");
    expect(() => restoreESPHomeSensitivePlaceholders(flowMasked.content, flowSource)).toThrow(/flow-style YAML collections/);

    const sanitized = sanitizeESPHomeResult({
      password: "not-in-yaml",
      output: "connection failed for known-plain-value",
    }, ["known-plain-value"]);
    expect(sanitized).toEqual({ password: "<redacted>", output: "connection failed for <redacted>" });
  });

  it("rejects moving a sensitive placeholder to another YAML field", () => {
    const source = "wifi:\n  password: wifi-value\nmqtt:\n  password: mqtt-value\n";
    const masked = maskESPHomeSensitiveText(source);
    const moved = masked.content.replace("wifi:\n  password:", "wifi:\n  token:");
    expect(() => restoreESPHomeSensitivePlaceholders(moved, source)).toThrow(/must remain at/);
  });

  it("masks sensitive substitution definitions and rejects multiline flow edits", () => {
    const substitutionSource = "substitutions:\n  network_credential: $inner_credential\n  inner_credential: exposed-secret\nwifi:\n  password: $network_credential\n";
    const substitutionMasked = maskESPHomeSensitiveText(substitutionSource);
    expect(substitutionMasked.content).not.toContain("exposed-secret");
    expect(restoreESPHomeSensitivePlaceholders(substitutionMasked.content, substitutionSource)).toBe(substitutionSource);

    const flowSource = "wifi:\n  networks: [\n    {ssid: one, password: first-secret},\n    {ssid: two, password: second-secret}\n  ]\n";
    const flowMasked = maskESPHomeSensitiveText(flowSource);
    expect(flowMasked.content).not.toContain("first-secret");
    expect(flowMasked.content).not.toContain("second-secret");
    expect(() => restoreESPHomeSensitivePlaceholders(flowMasked.content, flowSource)).toThrow(/flow-style YAML collections/);
  });
});
