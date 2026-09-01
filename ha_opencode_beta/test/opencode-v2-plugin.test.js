import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin, {
  CALLER_SECRET_FD,
  MCP_SERVER_NAME,
  NATIVE_MCP_SERVER_NAME,
  PLUGIN_ID,
  createSetup,
  createServerConfig,
  parseOptions,
  readCallerSecret,
} from "../rootfs/opt/opencode-v2-homeassistant/plugin.js";

const DEFAULT_OPTIONS = Object.freeze({
  endpoint: "http://127.0.0.1:43110/mcp",
});
const CALLER_SECRET = "a1".repeat(32);

describe("Home Assistant OpenCode V2 plugin", () => {
  it("has a stable first-party ID", () => {
    assert.equal(PLUGIN_ID, "homeassistant.mcp");
  });

  it("normalizes a safe loopback endpoint and timeout defaults", () => {
    assert.deepEqual(parseOptions(DEFAULT_OPTIONS), {
      endpoint: "http://127.0.0.1:43110/mcp",
      nativeEnabled: false,
      nativeEndpoint: "http://127.0.0.1:43110/native-mcp",
      timeouts: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
  });

  it("rejects unsafe native endpoints and invalid enablement", () => {
    for (const nativeEndpoint of [
      "http://192.0.2.1:43110/native-mcp",
      "http://127.0.0.1:43110/mcp",
      "http://127.0.0.1:43110/native-mcp?token=secret",
    ]) {
      assert.throws(
        () => parseOptions({ ...DEFAULT_OPTIONS, nativeEnabled: true, nativeEndpoint }),
        /plain loopback HTTP URL/,
      );
    }
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, nativeEnabled: "true" }),
      /must be true or false/,
    );
  });

  it("rejects remote, credential-bearing, and non-HTTP endpoints", () => {
    for (const endpoint of [
      "https://127.0.0.1:43110/mcp",
      "http://192.0.2.1:43110/mcp",
      "http://user:password@127.0.0.1:43110/mcp",
      "http://127.0.0.1:43110/secret",
      "http://127.0.0.1:43110/mcp?api_key=secret",
      "http://127.0.0.1:43110/mcp#secret",
      "file:///tmp/mcp.sock",
    ]) {
      assert.throws(() => parseOptions({ ...DEFAULT_OPTIONS, endpoint }), /plain loopback HTTP URL/);
    }
  });

  it("keeps parsing credential, header, token, and profile options out of plugin config", () => {
    for (const name of ["credential", "headers", "supervisorToken", "token", "profile"]) {
      assert.throws(
        () => parseOptions({ ...DEFAULT_OPTIONS, [name]: "sentinel" }),
        new RegExp(`Unknown Home Assistant plugin option: ${name}`),
      );
    }

    assert.doesNotMatch(JSON.stringify(parseOptions(DEFAULT_OPTIONS)), /credential|header|profile|secret|token/i);
  });

  it("rejects invalid timeout values", () => {
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { execution: 0 } }),
      /positive integer/,
    );
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { request: 1000 } }),
      /Unknown Home Assistant MCP timeout option/,
    );
  });

  it("reads the caller secret from fd 3 and closes it before returning", () => {
    const calls = [];
    const secret = readCallerSecret({
      read(fd, encoding) {
        calls.push(["read", fd, encoding]);
        return CALLER_SECRET;
      },
      close(fd) {
        calls.push(["close", fd]);
      },
    });

    assert.equal(secret, CALLER_SECRET);
    assert.deepEqual(calls, [
      ["read", CALLER_SECRET_FD, "utf8"],
      ["close", CALLER_SECRET_FD],
    ]);
  });

  it("closes the caller-secret fd on read and validation failures", () => {
    let closeCount = 0;
    assert.throws(
      () => readCallerSecret({
        read() {
          throw new Error("fd read failed");
        },
        close() {
          closeCount += 1;
        },
      }),
      /fd read failed/,
    );
    assert.equal(closeCount, 1);

    assert.throws(
      () => readCallerSecret({
        read: () => "A".repeat(64),
        close() {
          closeCount += 1;
        },
      }),
      /64 lowercase hexadecimal characters/,
    );
    assert.equal(closeCount, 2);
  });

  it("builds a direct-tool remote MCP config with an in-memory bearer header", () => {
    const config = createServerConfig(parseOptions(DEFAULT_OPTIONS), CALLER_SECRET);

    assert.deepEqual(config, {
      type: "remote",
      url: "http://127.0.0.1:43110/mcp",
      headers: { Authorization: `Bearer ${CALLER_SECRET}` },
      oauth: false,
      disabled: false,
      codemode: false,
      timeout: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
    assert.doesNotMatch(JSON.stringify(DEFAULT_OPTIONS), new RegExp(CALLER_SECRET));
  });

  it("registers MCP without putting the secret in options, then disposes it", async () => {
    let transform;
    const disposed = [];
    const options = { ...DEFAULT_OPTIONS };
    const setup = createSetup({ readSecret: () => CALLER_SECRET });
    const cleanup = await setup({
      options,
      mcp: {
        async transform(callback) {
          transform = callback;
          return {
            async dispose() {
              disposed.push("mcp");
            },
          };
        },
      },
    });

    const servers = new Map();
    transform({ set: (name, value) => servers.set(name, value) });

    assert.equal(servers.size, 1);
    assert.equal(servers.get(MCP_SERVER_NAME).codemode, false);
    assert.equal(servers.get(MCP_SERVER_NAME).headers.Authorization, `Bearer ${CALLER_SECRET}`);
    assert.deepEqual(options, DEFAULT_OPTIONS);
    assert.doesNotMatch(JSON.stringify(options), new RegExp(CALLER_SECRET));

    await cleanup();
    assert.deepEqual(disposed, ["mcp"]);
  });

  it("registers native Home Assistant as a second MCP with the same in-memory bearer", async () => {
    let transform;
    const options = { ...DEFAULT_OPTIONS, nativeEnabled: true };
    const setup = createSetup({ readSecret: () => CALLER_SECRET });
    const cleanup = await setup({
      options,
      mcp: {
        async transform(callback) {
          transform = callback;
          return { async dispose() {} };
        },
      },
    });

    const servers = new Map();
    transform({ set: (name, value) => servers.set(name, value) });

    assert.deepEqual([...servers.keys()], [MCP_SERVER_NAME, NATIVE_MCP_SERVER_NAME]);
    assert.equal(servers.get(NATIVE_MCP_SERVER_NAME).url, "http://127.0.0.1:43110/native-mcp");
    assert.equal(
      servers.get(NATIVE_MCP_SERVER_NAME).headers.Authorization,
      servers.get(MCP_SERVER_NAME).headers.Authorization,
    );
    assert.doesNotMatch(JSON.stringify(options), new RegExp(CALLER_SECRET));
    await cleanup();
  });

  it("keeps the default export on the pinned Plugin.define setup contract", () => {
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(typeof plugin.setup, "function");
  });
});
