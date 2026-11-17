// Stable fixes must reach beta before the next promotion. Keep the reviewed
// divergence list explicit while stable remains at 3.5.0 and beta at 3.5.1.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const repo = resolve(__dirname, "../..");
const beta = file => readFileSync(join(repo, "ha_opencode_beta", file), "utf8").replace(/\r\n/g, "\n");
const stable = file => readFileSync(join(repo, "ha_opencode", file), "utf8").replace(/\r\n/g, "\n");
const reviewed = new Map([
  [".dockerignore", "b1 adds the legacy-data boundary fixture"],
  ["Dockerfile", "b1 adds legacy-data checks and documents release metadata placement"],
  ["rootfs/etc/s6-overlay/s6-rc.d/ha-openchamber-ingress/run", "b2 forwards channel identity"],
  ["rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run", "channel identity and decision-note root"],
  ["rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-v2-server/run", "b0 native update configuration"],
  ["rootfs/etc/s6-overlay/s6-rc.d/init-opencode/run", "b0 single instruction owner and native client configuration"],
  ["rootfs/opt/ha-lsp-server/server.js", "channel-specific pattern URL"],
  ["rootfs/opt/ha-mcp-server/AGENTS.md", "b0 workspace and Code Mode guidance"],
  ["rootfs/opt/ha-mcp-server/index.js", "channel-specific pattern URL and version-neutral read-only HAB description"],
  ["rootfs/opt/ha-mcp-server/lib/hab-read-only.js", "b1 version-neutral rejection message"],
  ["rootfs/opt/opencode-assist/install.py", "channel-specific companion owner"],
  ["rootfs/opt/opencode-v2-homeassistant/agent-capability-context.js", "b0 Code Mode provenance"],
  ["rootfs/opt/opencode-v2-homeassistant/container-init.c", "b1 cold-start expiry"],
  ["rootfs/opt/opencode-v2-homeassistant/external-mcp.js", "b0 native disabled and codemode fields"],
  ["rootfs/opt/opencode-v2-homeassistant/managed-config.js", "b0 schema, policies and Code Mode"],
  ["rootfs/opt/opencode-v2-homeassistant/mcp-startup.js", "channel-specific persisted provenance"],
  ["rootfs/opt/opencode-v2-homeassistant/plugin.js", "b0 Code Mode registration and direct review tools"],
  ["rootfs/opt/opencode-v2-homeassistant/user-config.js", "b0 full native schema validation"],
  ["rootfs/usr/local/bin/deploy-opencode-assets.mjs", "b0 corrected native skills/agents comments"],
  ["rootfs/usr/local/bin/ha-context", "b3 active global instructions"],
  ["rootfs/usr/local/bin/opencode", "b1 legacy-data CLI"],
  ["rootfs/usr/local/bin/opencode-v2-migrate.py", "b0 native update spelling"],
  ["rootfs/usr/local/bin/opencode-v2-tui-state.py", "b0 native client config conversion"],
  ["rootfs/usr/local/lib/opencode/channel.sh", "b3 retired instruction variables"],
  ["rootfs/usr/local/lib/opencode/v2-environment.sh", "b0 corrected migration comments"],
]);

test("beta carries every shared stable runtime/build file except reviewed divergences", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--",
    "ha_opencode/rootfs", "ha_opencode/compat", "ha_opencode/Dockerfile", "ha_opencode/.dockerignore",
  ], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 100, "the baseline inventory must not silently be empty");
  for (const file of files) {
    const relative = file.slice("ha_opencode/".length);
    const current = beta(relative); // Missing files fail, even for reviewed paths.
    if (reviewed.has(relative)) continue;
    assert.equal(current, stable(relative), `Unreviewed stable/beta divergence: ${relative}`);
  }
  for (const file of reviewed.keys()) {
    assert.ok(files.includes(`ha_opencode/${file}`), `Remove stale divergence entry: ${file}`);
    assert.notEqual(beta(file), stable(file), `Reconciled file no longer needs an exception: ${file}`);
  }
});

test("beta preserves stable project-upgrade repair and HAB cache integration", () => {
  const migration = "rootfs/usr/local/bin/opencode-v2-migrate.py";
  assert.equal(beta(migration), stable(migration).replace('"autoupdate": False', '"update": "disable"'));
  const server = "rootfs/opt/ha-mcp-server/index.js";
  const normalized = stable(server)
    .replace("/main/ha_opencode/rootfs/", "/main/ha_opencode_beta/rootfs/")
    .replace("Enforced read-only subset of pinned HAB 1.8.0", "Enforced read-only subset of the app's pinned HAB");
  assert.equal(beta(server), normalized);
  for (const file of ["test/fixtures/opencode-v2-project-upgrade.py", "test/hab-cli-fixture.mjs"]) {
    assert.equal(beta(file), stable(file), `${file} must retain the stable behavioral coverage`);
  }
});

test("reconciled beta keeps its channel identity and default-off experiments", () => {
  const config = beta("config.yaml");
  assert.match(config, /^slug: "ha_opencode_beta"$/m);
  assert.match(config, /^image: "ghcr.io\/magnusoverli\/ha_opencode_beta"$/m);
  assert.match(config, /^  mcp_code_mode: false$/m);
  assert.match(beta("rootfs/opt/opencode-assist/install.py"), /^OWNER = "ha_opencode_beta"$/m);
  assert.match(beta("rootfs/opt/opencode-v2-homeassistant/mcp-startup.js"), /state\.channel !== "beta"/);
  assert.match(beta("rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run"), /^\s+ADDON_CHANNEL=beta \\$/m);
});
