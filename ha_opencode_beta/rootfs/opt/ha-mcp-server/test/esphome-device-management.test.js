import { describe, expect, it } from "vitest";
import {
  listESPHomeBoards,
  manageESPHomeApiKey,
  manageESPHomeFile,
  manageESPHomeFirmware,
  manageESPHomeHistory,
  manageESPHomeLifecycle,
  manageESPHomeMetadata,
  manageESPHomePairing,
  manageESPHomeSecrets,
  manageESPHomeSerial,
  searchESPHomeYaml,
  sanitizeESPHomeResultWithSecrets,
  streamESPHomeLogs,
  validateESPHomeContainedPath,
} from "../lib/esphome-device-management.js";
import { sha256Text } from "../lib/esphome-device-builder.js";

function recordingClient(handler) {
  const calls = [];
  return {
    calls,
    async command(command, args = {}) {
      calls.push({ command, args });
      return handler(command, args, calls);
    },
    async stream(command, args = {}, options = {}) {
      calls.push({ command, args, options, stream: true });
      return handler(command, args, calls, options);
    },
  };
}

const kitchenDevice = {
  name: "kitchen",
  friendly_name: "Kitchen",
  configuration: "kitchen.yaml",
  target_platform: "ESP32",
};

describe("ESPHome lifecycle and inventory management", () => {
  it("lists filtered board IDs through the paged board catalog", async () => {
    const client = recordingClient((command) => {
      expect(command).toBe("boards/get_boards");
      return { total: 1, offset: 0, limit: 25, boards: [{ id: "esp32dev", name: "ESP32 Dev" }] };
    });
    const result = await listESPHomeBoards(client, { platform: "esp32", limit: 25 });
    expect(result.boards[0].id).toBe("esp32dev");
    expect(client.calls[0].args).toEqual({ offset: 0, limit: 25, platform: "esp32" });
  });

  it("searches raw device YAML with bounded context", async () => {
    const client = recordingClient((command) => command === "yaml/search"
      ? [{ configuration: "kitchen.yaml", matches: [{ line_number: 4, line_text: "wifi:" }] }]
      : null);
    const result = await searchESPHomeYaml(client, { query: "wifi", maxResults: 20, contextLines: 1 });
    expect(result.results).toHaveLength(1);
    expect(client.calls[0].args).toMatchObject({ query: "wifi", max_results: 20, context_lines: 1 });
  });

  it("previews and applies adoption from a fresh discoverable-device lookup", async () => {
    const candidate = {
      name: "factory-node",
      friendly_name: "Factory Node",
      project_name: "vendor.product",
      package_import_url: "https://example.invalid/package.yaml",
    };
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [], importable: [candidate] };
      if (command === "devices/import") return { configuration: "factory-node.yaml" };
      throw new Error(`Unexpected command ${command}`);
    });
    const preview = await manageESPHomeLifecycle(client, { action: "adopt", deviceName: "factory-node" });
    expect(preview).toMatchObject({ applied: false, ready_to_apply: true });
    expect(client.calls.some((call) => call.command === "devices/import")).toBe(false);

    const applied = await manageESPHomeLifecycle(client, { action: "adopt", deviceName: "factory-node", apply: true });
    expect(applied).toMatchObject({ applied: true, result: { configuration: "factory-node.yaml" } });
  });

  it.each([
    ["clone", "devices/clone", { newName: "kitchen-copy" }],
    ["rename", "devices/rename", { newName: "new-kitchen" }],
    ["archive", "devices/archive", {}],
  ])("hash-guards and applies %s", async (action, expectedCommand, extra) => {
    const content = "esphome:\n  name: kitchen\n";
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice], importable: [] };
      if (command === "devices/get_config") return content;
      if (command === expectedCommand) return { configuration: `${extra.newName || "kitchen"}.yaml` };
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeLifecycle(client, {
      action,
      configuration: "kitchen.yaml",
      expectedSha256: sha256Text(content),
      apply: true,
      ...extra,
    });
    expect(result.applied).toBe(true);
    expect(client.calls.some((call) => call.command === expectedCommand)).toBe(true);
  });

  it("requires an exact permanent-delete confirmation", async () => {
    const content = "esphome:\n  name: kitchen\n";
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice], importable: [] };
      if (command === "devices/get_config") return content;
      if (command === "devices/delete") return null;
      throw new Error(`Unexpected command ${command}`);
    });
    await expect(manageESPHomeLifecycle(client, {
      action: "delete",
      configuration: "kitchen.yaml",
      expectedSha256: sha256Text(content),
      confirmation: "yes",
      apply: true,
    })).rejects.toThrow(/confirmation must exactly equal/);
    expect(client.calls.some((call) => call.command === "devices/delete")).toBe(false);
  });

  it("refuses lifecycle operations for top-level YAML that is not a device", async () => {
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice], importable: [] };
      throw new Error(`Unexpected command ${command}`);
    });
    await expect(manageESPHomeLifecycle(client, {
      action: "archive",
      configuration: "common.yaml",
      apply: false,
    })).rejects.toThrow(/not an active configured device/);
  });
});

describe("ESPHome metadata, files, secrets, and keys", () => {
  it("redacts actual scalar and block values loaded from secrets.yaml", async () => {
    const client = recordingClient((command) => {
      if (command === "devices/get_config") return "mqtt_password: plain-value\ncertificate: |-\n  first-line\n  second-line\n";
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await sanitizeESPHomeResultWithSecrets(client, {
      output: "plain-value first-line second-line",
    });
    expect(JSON.stringify(result)).not.toContain("plain-value");
    expect(JSON.stringify(result)).not.toContain("first-line");
    expect(JSON.stringify(result)).not.toContain("second-line");
  });

  it("updates YAML-backed friendly names only after hash approval", async () => {
    const content = "esphome:\n  name: kitchen\n";
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice] };
      if (command === "devices/get_config") return content;
      if (command === "devices/edit_friendly_name") return { configuration: "kitchen.yaml", rewritten: true };
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeMetadata(client, {
      action: "set_friendly_name",
      configuration: "kitchen.yaml",
      friendlyName: "New Kitchen",
      expectedSha256: sha256Text(content),
      apply: true,
    });
    expect(result.applied).toBe(true);
  });

  it("confines companion YAML paths", () => {
    expect(validateESPHomeContainedPath("packages/common.yaml")).toBe("packages/common.yaml");
    expect(() => validateESPHomeContainedPath("../secrets.yaml")).toThrow(/parent-directory/);
    expect(() => validateESPHomeContainedPath("secrets.yaml")).toThrow(/esphome_secrets/);
  });

  it("hash-guards companion updates and validates referencing devices afterward", async () => {
    const original = "sensor: []\n";
    const candidate = "sensor:\n  - platform: uptime\n";
    let persisted = original;
    const client = recordingClient((command, args) => {
      if (command === "devices/get_config") {
        if (args.configuration === "packages/common.yaml") return persisted;
        return "esphome:\n  name: kitchen\npackages: !include packages/common.yaml\n";
      }
      if (command === "yaml/search") return [{ configuration: "kitchen.yaml" }];
      if (command === "devices/update_config") {
        persisted = args.content;
        return null;
      }
      if (command === "editor/validate_yaml") return { yaml_errors: [], validation_errors: [] };
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeFile(client, {
      action: "update",
      filePath: "packages/common.yaml",
      content: candidate,
      expectedSha256: sha256Text(original),
      apply: true,
    });
    expect(result).toMatchObject({ applied: true, manual_recovery_required: false });
    expect(persisted).toBe(candidate);
  });

  it("rejects a companion path whose content resolves to secrets.yaml", async () => {
    const secretContent = "wifi_password: private\n";
    const client = recordingClient((command) => {
      if (command === "devices/get_config") return secretContent;
      throw new Error(`Unexpected command ${command}`);
    });
    await expect(manageESPHomeFile(client, {
      action: "read",
      filePath: "packages/alias.yaml",
    })).rejects.toThrow(/resolves to, or duplicates, secrets.yaml/);
  });

  it("returns a secrets fingerprint without exposing values", async () => {
    const client = recordingClient((command) => command === "devices/get_config" ? "wifi_ssid: private\n" : []);
    const result = await manageESPHomeSecrets(client, { action: "fingerprint" });
    expect(result).toMatchObject({ values_redacted: true, sha256: sha256Text("wifi_ssid: private\n") });
    expect(result).not.toHaveProperty("content");
  });

  it("previews shared encryption-secret impact without returning key material", async () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const client = recordingClient((command) => command === "yaml/search"
      ? [{ configuration: "one.yaml" }, { configuration: "two.yaml" }]
      : command === "devices/list"
        ? { configured: [], importable: [] }
      : null);
    const preview = await manageESPHomeApiKey(client, {
      action: "set_secret",
      secretKey: "api_encryption_key",
      key,
    });
    expect(preview).toMatchObject({ applied: false, affected_configurations: ["one.yaml", "two.yaml"] });
  });

  it("requires the current key fingerprint and exact confirmation before rotation", async () => {
    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const newKey = Buffer.alloc(32, 2).toString("base64");
    const client = recordingClient((command) => {
      if (command === "yaml/search") return [{ configuration: "one.yaml" }];
      if (command === "devices/list") return { configured: [{ configuration: "one.yaml" }] };
      if (command === "devices/get_api_key") return { key: oldKey };
      if (command === "config/set_secret") return { created: false };
      throw new Error(`Unexpected command ${command}`);
    });
    await expect(manageESPHomeApiKey(client, {
      action: "set_secret",
      secretKey: "api_key",
      key: newKey,
      expectedKeySha256: sha256Text(oldKey),
      confirmation: "wrong",
      apply: true,
    })).rejects.toThrow(/confirmation must exactly equal/);
    expect(client.calls.some((call) => call.command === "config/set_secret")).toBe(false);
  });

  it("can select a package-only API-key impact group by fingerprint", async () => {
    const oldKey = Buffer.alloc(32, 3).toString("base64");
    const fingerprint = sha256Text(oldKey);
    const client = recordingClient((command) => {
      if (command === "yaml/search") return [];
      if (command === "devices/list") return { configured: [{ configuration: "package-node.yaml" }] };
      if (command === "devices/get_api_key") return { key: oldKey };
      throw new Error(`Unexpected command ${command}`);
    });
    const preview = await manageESPHomeApiKey(client, {
      action: "set_secret",
      secretKey: "package_api_key",
      key: Buffer.alloc(32, 4).toString("base64"),
      expectedKeySha256: fingerprint,
    });
    expect(preview).toMatchObject({
      ready_to_apply: true,
      impact_complete: true,
      affected_configurations: ["package-node.yaml"],
    });
  });
});

describe("ESPHome history, jobs, logs, and serial workflows", () => {
  it("lists and restores history with a stale-source guard", async () => {
    const content = "esphome:\n  name: kitchen\n";
    const restored = "esphome:\n  name: old-kitchen\n";
    let current = content;
    const client = recordingClient((command, args) => {
      if (command === "devices/get_config") return args.configuration === "secrets.yaml" ? "wifi_password: unrelated\n" : current;
      if (command === "version_history/restore") {
        current = restored;
        return { restored_from: "abcdef0", content: restored };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeHistory(client, {
      action: "restore",
      filePath: "kitchen.yaml",
      sha: "abcdef0",
      expectedSha256: sha256Text(content),
      apply: true,
    });
    expect(result).toMatchObject({ applied: true, restored_from: "abcdef0", restored_sha256: sha256Text(restored) });
  });

  it("fails closed when current history state cannot be read", async () => {
    const client = recordingClient((command) => {
      if (command === "devices/get_config") throw new Error("transport unavailable");
      if (command === "version_history/restore") return {};
      throw new Error(`Unexpected command ${command}`);
    });
    await expect(manageESPHomeHistory(client, {
      action: "restore",
      filePath: "kitchen.yaml",
      sha: "abcdef0",
      apply: true,
    })).rejects.toThrow(/transport unavailable/);
    expect(client.calls.some((call) => call.command === "version_history/restore")).toBe(false);
  });

  it("queues a compile-and-install chain and returns both jobs", async () => {
    const head = { job_id: "head", configuration: "kitchen.yaml", output: [] };
    const tail = { job_id: "tail", configuration: "kitchen.yaml", depends_on: "head", output: [] };
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice] };
      if (command === "firmware/install") return head;
      if (command === "firmware/get_jobs") return [tail, head];
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeFirmware(client, {
      action: "install",
      configuration: "kitchen.yaml",
      apply: true,
    });
    expect(result.jobs.map((job) => job.job_id)).toEqual(["tail", "head"]);
  });

  it("streams bounded device logs through the cancellable stream API", async () => {
    const client = recordingClient((command) => {
      if (command === "devices/list") return { configured: [kitchenDevice] };
      if (command === "devices/logs") return {
        events: [{ event: "output", data: "first" }, { event: "result", data: { success: true, code: 0 } }],
        truncated: false,
        stopReason: "",
      };
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await streamESPHomeLogs(client, { configuration: "kitchen.yaml", durationSeconds: 5 });
    expect(result).toMatchObject({ output: ["first"], terminal: { success: true, code: 0 } });
  });

  it("detects a serial chip before queueing a forced-local install", async () => {
    const client = recordingClient((command) => {
      if (command === "config/detect_chip") return { platform: "esp32", board_id: "esp32dev" };
      if (command === "devices/list") return { configured: [kitchenDevice] };
      if (command === "firmware/install") return { job_id: "head", output: [] };
      if (command === "firmware/get_jobs") return [];
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomeSerial(client, {
      action: "install",
      port: "COM3",
      configuration: "kitchen.yaml",
      expectedPlatform: "esp32",
      apply: true,
    });
    expect(result).toMatchObject({ applied: true, force_local: true });
    expect(client.calls.find((call) => call.command === "firmware/install").args.force_local).toBe(true);
  });

  it("previews and confirms remote-build pairing against the observed pin", async () => {
    const pin = "a".repeat(64);
    const client = recordingClient((command) => {
      if (command === "remote_build/preview_pair") return { pin_sha256: pin, requires_pairing_key: false };
      if (command === "remote_build/request_pair") return { pin_sha256: pin, status: "pending" };
      throw new Error(`Unexpected command ${command}`);
    });
    const result = await manageESPHomePairing(client, {
      action: "request",
      hostname: "builder.local",
      port: 6055,
      pinSha256: pin,
      confirmation: `PAIR ${pin}`,
      apply: true,
    });
    expect(result).toMatchObject({ applied: true, result: { status: "pending" } });
  });
});
