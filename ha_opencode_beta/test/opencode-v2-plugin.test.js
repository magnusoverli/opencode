import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin, {
  MCP_SERVER_NAME,
  PLUGIN_ID,
  createServerConfig,
  parseOptions,
} from "../rootfs/opt/opencode-v2-homeassistant/plugin.js";

const DEFAULT_OPTIONS = Object.freeze({
  endpoint: "http://127.0.0.1:43110/mcp",
});

describe("Home Assistant OpenCode V2 plugin", () => {
  it("has a stable first-party ID", () => {
    assert.equal(PLUGIN_ID, "homeassistant.mcp");
  });

  it("normalizes a safe loopback endpoint and timeout defaults", () => {
    assert.deepEqual(parseOptions(DEFAULT_OPTIONS), {
      endpoint: "http://127.0.0.1:43110/mcp",
      timeouts: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
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

  it("rejects unknown options so credentials cannot drift into plugin config", () => {
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, supervisorToken: "sentinel" }),
      /Unknown Home Assistant plugin option: supervisorToken/,
    );
  });

  it("rejects profile selection and invalid timeout values", () => {
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, profile: "full" }),
      /Unknown Home Assistant plugin option: profile/,
    );
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { execution: 0 } }),
      /positive integer/,
    );
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { request: 1000 } }),
      /Unknown Home Assistant MCP timeout option/,
    );
  });

  it("builds a direct-tool remote MCP config without an authentication secret", () => {
    const config = createServerConfig(parseOptions(DEFAULT_OPTIONS));

    assert.deepEqual(config, {
      type: "remote",
      url: "http://127.0.0.1:43110/mcp",
      oauth: false,
      disabled: false,
      codemode: false,
      timeout: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
    assert.doesNotMatch(JSON.stringify(config), /token|authorization|cookie/i);
  });

  it("registers one MCP transform and disposes it on unload", async () => {
    let transform;
    let disposeCount = 0;
    const cleanup = await plugin.setup({
      options: DEFAULT_OPTIONS,
      mcp: {
        async transform(callback) {
          transform = callback;
          return {
            async dispose() {
              disposeCount += 1;
            },
          };
        },
      },
    });

    const servers = new Map();
    transform({ set: (name, value) => servers.set(name, value) });

    assert.equal(servers.size, 1);
    assert.equal(servers.get(MCP_SERVER_NAME).codemode, false);

    await cleanup();
    assert.equal(disposeCount, 1);
  });
});
