import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildManagedConfig,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_PLUGIN_PACKAGE,
  DEFAULT_RUNTIME_GUARD_PACKAGE,
} from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

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
