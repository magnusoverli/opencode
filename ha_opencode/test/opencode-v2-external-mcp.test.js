import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EXTERNAL_MCP_LAUNCHER,
  EXTERNAL_MCP_UID_BASE,
  prepareExternalMcpConfig,
  readExternalMcpSecret,
  resolveExternalServers,
} from "../rootfs/opt/opencode-v2-homeassistant/external-mcp.js";
import {
  applyExternalMcpConfig,
  buildManagedConfig,
  DEFAULT_PLUGIN_PACKAGE,
} from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { createSetup, parseOptions } from "../rootfs/opt/opencode-v2-homeassistant/plugin.js";
import { prepareUserConfig } from "../rootfs/opt/opencode-v2-homeassistant/user-config.js";

const secret = (name) => `{file:/data/.config/opencode/mcp-secrets/${name}}`;

function fixture() {
  return {
    servers: {
      infrastructure: {
        type: "remote",
        url: "http://gateway.local/mcp",
        allow_insecure: true,
        headers: {
          Authorization: { secret_file: "infrastructure-auth", prefix: "Bearer " },
          Host: "gateway.local",
        },
      },
      metrics: {
        type: "local",
        command: ["/data/.config/opencode/bin/metrics-mcp", "--read-only"],
        environment: {
          METRICS_API_TOKEN: secret("metrics-token"),
        },
        literal_environment: {
          METRICS_URL: "http://metrics.local",
        },
      },
    },
    permissions: {
      "infrastructure_*": "ask",
      "infrastructure_get_*": "allow",
      "metrics_*": "allow",
    },
  };
}

describe("bounded external MCP configuration", () => {
  it("validates servers and translates ordered permissions with fail-safe defaults", () => {
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    assert.deepEqual(Object.keys(prepared.servers), ["infrastructure", "metrics"]);
    assert.deepEqual(prepared.permissions, [
      { action: "infrastructure_*", resource: "*", effect: "ask" },
      { action: "metrics_*", resource: "*", effect: "ask" },
      { action: "infrastructure_*", resource: "*", effect: "ask" },
      { action: "infrastructure_get_*", resource: "*", effect: "allow" },
      { action: "metrics_*", resource: "*", effect: "allow" },
    ]);
  });

  it("adds external servers only through the existing managed MCP plugin", () => {
    const external = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    const managed = applyExternalMcpConfig(buildManagedConfig({ pluginEnabled: true }), external);
    const plugin = managed.plugins.find(({ package: name }) => name === DEFAULT_PLUGIN_PACKAGE);
    assert.deepEqual(plugin.options.externalServers, external.servers);
    assert.deepEqual(managed.permissions.slice(-external.permissions.length), external.permissions);
    const externalOnly = applyExternalMcpConfig(buildManagedConfig(), external);
    const externalPlugin = externalOnly.plugins.find(({ package: name }) => name === DEFAULT_PLUGIN_PACKAGE);
    assert.deepEqual(externalPlugin.options, {
      bundledEnabled: false, nativeEnabled: false, externalServers: external.servers,
    });
    assert.deepEqual(externalOnly.permissions.slice(-external.permissions.length), external.permissions);
  });

  it("resolves secret files only when the plugin activates", async () => {
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    const requested = [];
    const resolved = await resolveExternalServers(prepared.servers, {
      readSecret: async (name) => {
        requested.push(name);
        return `resolved-${name}`;
      },
    });
    assert.deepEqual(requested.sort(), ["infrastructure-auth", "metrics-token"]);
    assert.equal(resolved.infrastructure.headers.Authorization, "Bearer resolved-infrastructure-auth");
    assert.equal(resolved.metrics.environment.METRICS_API_TOKEN, "resolved-metrics-token");
    assert.equal(resolved.infrastructure.disabled, false);
    assert.deepEqual(resolved.metrics.command, [
      EXTERNAL_MCP_LAUNCHER,
      String(EXTERNAL_MCP_UID_BASE + 1),
      "2",
      "METRICS_API_TOKEN",
      "METRICS_URL",
      "/data/.config/opencode/bin/metrics-mcp",
      "--read-only",
    ]);
    assert.equal(resolved.metrics.codemode, false);
  });

  it("does not resolve or register disabled external servers", async () => {
    const value = fixture();
    value.servers.infrastructure.enabled = false;
    let reads = 0;
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(value) });
    const resolved = await resolveExternalServers(prepared.servers, {
      readSecret: async () => { reads += 1; return "secret"; },
    });
    assert.equal(reads, 1, "only the enabled metrics server reads its token");
    assert.equal(resolved.infrastructure, undefined);
    assert.ok(resolved.metrics);
  });

  it("opens secret files relative to a non-symlinked directory descriptor", {
    skip: process.getuid?.() !== 0 ? "requires root-owned secret fixtures" : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "external-mcp-secrets-"));
    const parentLink = `${root}-link`;
    try {
      await writeFile(join(root, "token"), "safe-value\n", { mode: 0o600 });
      assert.equal(await readExternalMcpSecret("token", { root }), "safe-value");
      await symlink(root, parentLink);
      await assert.rejects(() => readExternalMcpSecret("token", { root: parentLink }), /missing or invalid/);
      await symlink("token", join(root, "token-link"));
      await assert.rejects(() => readExternalMcpSecret("token-link", { root }), /missing or invalid/);
      await writeFile(join(root, "bad-mode"), "unsafe", { mode: 0o644 });
      await assert.rejects(() => readExternalMcpSecret("bad-mode", { root }), /missing or invalid/);
      await link(join(root, "token"), join(root, "token-hardlink"));
      await assert.rejects(() => readExternalMcpSecret("token", { root }), /missing or invalid/);
      await writeFile(join(root, "directory-mode"), "safe", { mode: 0o600 });
      await chmod(root, 0o755);
      await assert.rejects(() => readExternalMcpSecret("directory-mode", { root }), /missing or invalid/);
    } finally {
      await rm(parentLink, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ships an immutable launcher that clears credentials and drops privileges", async () => {
    const source = await readFile(new URL("../rootfs/opt/opencode-v2-homeassistant/external-mcp-launcher.c", import.meta.url), "utf8");
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(source, /O_NOFOLLOW/);
    assert.match(source, /clearenv\(\)/);
    assert.match(source, /setresgid\(runtime_id/);
    assert.match(source, /setresuid\(runtime_id/);
    assert.match(source, /fexecve\(target/);
    assert.match(dockerfile, /opencode-v2-external-mcp-launcher\.c/);
    assert.match(dockerfile, /-o \/usr\/local\/bin\/opencode-v2-external-mcp-launch/);
  });

  it("passes the bounded definitions through the plugin option parser", () => {
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    const parsed = parseOptions({
      endpoint: "http://127.0.0.1:8765/mcp",
      externalServers: prepared.servers,
    });
    assert.deepEqual(parsed.externalServers, prepared.servers);
  });

  it("registers external servers beside the managed Home Assistant MCP", async () => {
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    const registered = new Map();
    let transforms = 0;
    const setup = createSetup({
      readSecret: async () => "a".repeat(64),
      resolveExternal: async () => ({ metrics: { type: "local", command: ["/data/.config/opencode/bin/metrics-mcp"] } }),
    });
    const dispose = await setup({
      options: {
        endpoint: "http://127.0.0.1:8765/mcp",
        externalServers: prepared.servers,
      },
      mcp: {
        transform: async (callback) => {
          transforms++;
          callback(registered);
          return { dispose: async () => {} };
        },
      },
    });
    assert.equal(transforms, 2);
    assert.deepEqual([...registered.keys()], ["homeassistant", "metrics"]);
    await dispose();
  });

  it("keeps built-in Home Assistant MCP servers when external resolution fails", async () => {
    const registered = new Map();
    const messages = [];
    const originalError = console.error;
    console.error = (...items) => messages.push(items.join(" "));
    try {
      const setup = createSetup({
        readSecret: async () => "a".repeat(64),
        resolveExternal: async () => { throw new Error("sensitive resolver detail"); },
      });
      const dispose = await setup({
        options: {
          endpoint: "http://127.0.0.1:8765/mcp",
          nativeEnabled: true,
          externalServers: fixture().servers,
        },
        mcp: {
          transform: async (callback) => {
            callback(registered);
            return { dispose: async () => {} };
          },
        },
      });
      assert.deepEqual([...registered.keys()], ["homeassistant", "homeassistant_native"]);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /External MCP servers were not registered/);
      assert.doesNotMatch(messages[0], /sensitive resolver detail/);
      await dispose();
    } finally {
      console.error = originalError;
    }
  });

  it("registers external-only servers without requiring a HA endpoint or acquiring a sidecar secret", async () => {
    const prepared = prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(fixture()) });
    const registered = new Map();
    let disposed = false;
    const cleanup = await createSetup({
      readSecret() { assert.fail("external-only must not acquire HA credentials"); },
      resolveExternal: async () => ({ metrics: { type: "local", command: ["fixture"] } }),
    })({
      options: { bundledEnabled: false, nativeEnabled: false, externalServers: prepared.servers },
      mcp: { async transform(callback) { callback(registered); return { async dispose() { disposed = true; } }; } },
    });
    assert.deepEqual([...registered.keys()], ["metrics"]);
    await cleanup();
    assert.equal(disposed, true);
  });

  it("keeps external registration when the HA caller credential is unavailable", async () => {
    const registered = new Map();
    const messages = [];
    const originalError = console.error;
    console.error = (...items) => messages.push(items.join(" "));
    try {
      const cleanup = await createSetup({
        readSecret() { throw new Error("synthetic-secret-detail"); },
        resolveExternal: async () => ({ metrics: { type: "local", command: ["fixture"] } }),
      })({
        options: { endpoint: "http://127.0.0.1:8765/mcp", nativeEnabled: true, externalServers: fixture().servers },
        mcp: { async transform(callback) { callback(registered); return { async dispose() {} }; } },
      });
      assert.deepEqual([...registered.keys()], ["metrics"]);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /Home Assistant MCP registration failed/);
      assert.doesNotMatch(messages[0], /synthetic-secret-detail/);
      await cleanup();
    } finally { console.error = originalError; }
  });

  it("imports compatible V1 mcp and permission fields on first V2 startup", () => {
    const legacy = fixture();
    legacy.servers.infrastructure.oauth = false;
    legacy.servers.infrastructure.timeout = 60_000;
    legacy.servers.metrics.timeout = 60_000;
    legacy.permission = {
      read: { "/data/.config/opencode/mcp-secrets/*": "deny" },
      ...legacy.permissions,
    };
    legacy.mcp = legacy.servers;
    delete legacy.servers;
    delete legacy.permissions;
    const prepared = prepareUserConfig({ opencode_config: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: legacy.mcp,
      permission: legacy.permission,
    }) });
    assert.deepEqual(prepared.config, { $schema: "https://opencode.ai/config.json" });
    assert.deepEqual(Object.keys(prepared.externalMcp.servers), ["infrastructure", "metrics"]);
    assert.deepEqual(prepared.externalMcp.servers.infrastructure.timeout, {
      startup: 60_000,
      catalog: 60_000,
      execution: 60_000,
    });
    assert.ok(prepared.externalMcp.permissions.some(({ action, effect }) => action === "infrastructure_get_*" && effect === "allow"));
  });

  it("rejects ambiguous legacy and dedicated external MCP configuration", () => {
    const value = fixture();
    assert.throws(() => prepareUserConfig({
      opencode_config: JSON.stringify({ mcp: value.servers, permission: value.permissions }),
      external_mcp_config: JSON.stringify(value),
    }), /configuring both|move legacy/);
  });

  it("normalizes compatible legacy plaintext URLs during migration", () => {
    for (const url of ["HTTP://gateway.local/mcp", " http://gateway.local/mcp "]) {
      const prepared = prepareUserConfig({ opencode_config: JSON.stringify({
        mcp: { legacy: { type: "remote", url, oauth: false } },
      }) });
      assert.equal(prepared.externalMcp.servers.legacy.allow_insecure, true);
    }
  });

  it("normalizes compatible legacy secret header references during migration", async () => {
    const prepared = prepareUserConfig({ opencode_config: JSON.stringify({
      mcp: {
        legacy: {
          type: "remote",
          url: "https://gateway.local/mcp",
          oauth: false,
          headers: { Authorization: "Bearer {file:/data/.config/opencode/mcp-secrets/legacy-token}" },
        },
      },
    }) });
    assert.deepEqual(prepared.externalMcp.servers.legacy.headers.Authorization, {
      secret_file: "legacy-token",
      prefix: "Bearer ",
    });
    const resolved = await resolveExternalServers(prepared.externalMcp.servers, {
      readSecret: async () => "resolved",
    });
    assert.equal(resolved.legacy.headers.Authorization, "Bearer resolved");
  });

  it("rejects more than 64 combined local environment entries", () => {
    const value = fixture();
    value.servers.metrics.environment = Object.fromEntries(Array.from(
      { length: 33 },
      (_, index) => [`SECRET_${index}`, secret(`secret-${index}`)],
    ));
    value.servers.metrics.literal_environment = Object.fromEntries(Array.from(
      { length: 32 },
      (_, index) => [`LITERAL_${index}`, `value-${index}`],
    ));
    assert.throws(
      () => prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(value) }),
      /exceeds 64 combined entries/,
    );
  });

  for (const [label, mutate] of [
    ["literal authorization", (value) => { value.servers.infrastructure.headers.Authorization = "Bearer secret"; }],
    ["literal API key", (value) => { value.servers.infrastructure.headers["X-API-Key"] = "secret"; }],
    ["literal proxy authorization", (value) => { value.servers.infrastructure.headers["Proxy-Authorization"] = "secret"; }],
    ["literal cookie", (value) => { value.servers.infrastructure.headers.Cookie = "secret"; }],
    ["literal custom header", (value) => { value.servers.infrastructure.headers["X-Access-Code"] = "secret"; }],
    ["plaintext HTTP without opt-in", (value) => { delete value.servers.infrastructure.allow_insecure; }],
    ["reserved local environment", (value) => { value.servers.metrics.environment.NODE_OPTIONS = "--inspect"; }],
    ["literal value in secret environment", (value) => { value.servers.metrics.environment.GITHUB_PAT = "secret"; }],
    ["shell command", (value) => { value.servers.metrics.command = ["sh", "-c", "do something"]; }],
    ["nested executable", (value) => { value.servers.metrics.command[0] = "/data/.config/opencode/bin/nested/tool"; }],
    ["reserved name", (value) => { value.servers.homeassistant = value.servers.infrastructure; }],
    ["unrelated permission", (value) => { value.permissions.shell = "allow"; }],
    ["URL credentials", (value) => { value.servers.infrastructure.url = "https://user:secret@example.test/mcp"; }],
  ]) {
    it(`rejects ${label} without returning supplied values`, () => {
      const value = fixture();
      mutate(value);
      assert.throws(
        () => prepareExternalMcpConfig({ external_mcp_config: JSON.stringify(value) }),
        (error) => error.message.startsWith("external_mcp_config:")
          && !error.message.includes("Bearer secret")
          && !error.message.includes("user:secret"),
      );
    });
  }
});
