import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildReadOnlyPermissions,
  buildManagedConfig,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_PLUGIN_PACKAGE,
  DEFAULT_RUNTIME_GUARD_PACKAGE,
  DEFAULT_WORKSPACE,
  READ_ONLY_AGENT_ID,
  READ_ONLY_AGENT_SYSTEM,
  WORKSPACE_INSTRUCTIONS,
} from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { TOOL_PROFILES } from "../rootfs/opt/ha-mcp-server/lib/tool-profiles.js";

const ADDON_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATOR = join(
  ADDON_ROOT,
  "rootfs",
  "opt",
  "opencode-v2-homeassistant",
  "managed-config.js",
);

describe("OpenCode V2 managed configuration", () => {
  it("translates the V1 safety policy into ordered native V2 rules", () => {
    const config = buildManagedConfig();

    assert.equal(config.snapshots, false);
    assert.equal(config.share, "disabled");
    assert.deepEqual(config.plugins, [{ package: DEFAULT_RUNTIME_GUARD_PACKAGE }]);
    assert.deepEqual(config.permissions.slice(0, 3), [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "allow" },
    ]);
    for (const resource of ["yq -i*", "sed -i*", "tee *", "rm *", "mv *"]) {
      assert.deepEqual(
        config.permissions.find((rule) => rule.action === "shell" && rule.resource === resource),
        { action: "shell", resource, effect: "ask" },
      );
    }
    assert.deepEqual(config.permissions.slice(-6), [
      "*secrets.yaml",
      "*.storage/*",
      "*.cloud/*",
      "*ssl/*",
      "*.key",
      "*.pem",
    ].map((resource) => ({ action: "read", resource, effect: "deny" })));
  });

  it("keeps the credential-bearing MCP plugin disabled until its sidecar is ready", () => {
    const disabled = buildManagedConfig();
    const enabled = buildManagedConfig({ pluginEnabled: true });

    assert.deepEqual(disabled.plugins, [{ package: DEFAULT_RUNTIME_GUARD_PACKAGE }]);
    assert.deepEqual(enabled.plugins, [
      { package: DEFAULT_RUNTIME_GUARD_PACKAGE },
      {
        package: DEFAULT_PLUGIN_PACKAGE,
        options: {
          endpoint: DEFAULT_MCP_ENDPOINT,
          timeouts: { startup: 30_000, catalog: 60_000, execution: 60_000 },
        },
      },
    ]);
  });

  it("defines a V2-native read-only agent whose final rules fail closed", () => {
    const config = buildManagedConfig();
    const agent = config.agents[READ_ONLY_AGENT_ID];

    assert.equal(agent.mode, "primary");
    assert.equal(agent.system, READ_ONLY_AGENT_SYSTEM);
    assert.deepEqual(agent.permissions, buildReadOnlyPermissions());
    assert.deepEqual(agent.permissions.slice(0, 5), [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "external_directory", resource: DEFAULT_WORKSPACE, effect: "allow" },
      { action: "external_directory", resource: `${DEFAULT_WORKSPACE}/**`, effect: "allow" },
    ]);
    for (const action of ["edit", "shell", "subagent", "lsp", "grep", "future_native_action"]) {
      assert.equal(agent.permissions.some((rule) => rule.action === action && rule.effect === "allow"), false);
    }

    const mcpRules = agent.permissions.filter((rule) => rule.action.startsWith("homeassistant_"));
    assert.deepEqual(mcpRules[0], { action: "homeassistant_*", resource: "*", effect: "deny" });
    assert.deepEqual(
      mcpRules.slice(1).map((rule) => rule.action),
      [...TOOL_PROFILES.compact.toolNames].map((name) => `homeassistant_${name}`),
    );
    assert.ok(mcpRules.slice(1).every((rule) => rule.effect === "allow" && rule.resource === "*"));
    for (const action of [
      "homeassistant_call_service",
      "homeassistant_write_config_safe",
      "homeassistant_remember_decision",
      "homeassistant_future_mutation",
    ]) {
      assert.equal(mcpRules.some((rule) => rule.action === action && rule.effect === "allow"), false);
    }
    assert.deepEqual(agent.permissions.slice(-6), [
      "*secrets.yaml",
      "*.storage/*",
      "*.cloud/*",
      "*ssl/*",
      "*.key",
      "*.pem",
    ].map((resource) => ({ action: "read", resource, effect: "deny" })));

    const unrestrictedGlobal = buildManagedConfig({ restrictSensitiveFiles: false });
    assert.equal(unrestrictedGlobal.permissions.some((rule) => rule.action === "read" && rule.effect === "deny"), false);
    assert.deepEqual(
      unrestrictedGlobal.agents[READ_ONLY_AGENT_ID].permissions.slice(-6),
      agent.permissions.slice(-6),
    );
  });

  it("loads bounded Home Assistant context from the activated workspace", () => {
    const config = buildManagedConfig({
      pluginEnabled: true,
      mcpProfile: "configuration",
      focusMode: true,
      userHooks: true,
    });

    assert.deepEqual(config.instructions, [
      WORKSPACE_INSTRUCTIONS,
      "/opt/ha-mcp-server/FOCUS_MODE.md",
      "/opt/ha-mcp-server/MCP_CORE_INSTRUCTIONS.md",
      "/opt/ha-mcp-server/MCP_PROFILE_CONFIGURATION.md",
      "/data/context/home-briefing.md",
      "/data/context/decision-notes.md",
      "/opt/ha-mcp-server/USER_HOOKS.md",
      `${DEFAULT_WORKSPACE}/AGENTS.local.md`,
    ]);
  });

  it("can disable sensitive-read rules without changing the base policy", () => {
    const config = buildManagedConfig({ restrictSensitiveFiles: false });

    assert.deepEqual(config.permissions.filter((rule) => rule.action === "read"), [
      { action: "read", resource: "*", effect: "allow" },
    ]);
    assert.equal(config.permissions.find((rule) => rule.action === "edit")?.effect, "ask");
  });

  it("prints one native JSON document and rejects unknown arguments", () => {
    const generated = spawnSync(process.execPath, [
      GENERATOR,
      "--restrict-sensitive-files",
      "false",
      "--plugin-enabled",
      "false",
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.deepEqual(JSON.parse(generated.stdout), buildManagedConfig({
      restrictSensitiveFiles: false,
      pluginEnabled: false,
    }));

    const rejected = spawnSync(process.execPath, [GENERATOR, "--unknown", "value"], {
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unknown managed-config option/);
    assert.equal(rejected.stdout, "");
  });
});
