// Shared implementation matches stable 3.5.2. Only exact, reviewed channel
// substitutions are permitted; new feature differences need explicit review.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const repo = resolve(__dirname, "../..");
const beta = file => readFileSync(join(repo, "ha_opencode_beta", file), "utf8").replace(/\r\n/g, "\n");
const stable = file => readFileSync(join(repo, "ha_opencode", file), "utf8").replace(/\r\n/g, "\n");
const patternChannel = source => source.replace("/main/ha_opencode/rootfs/", "/main/ha_opencode_beta/rootfs/");
const reviewed = new Map([
  ["rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run", source => source
    .replace("ADDON_CHANNEL=stable", "ADDON_CHANNEL=beta")
    .replace("OPENCODE_DECISION_NOTES_DIR:-/homeassistant/opencode}", "OPENCODE_DECISION_NOTES_DIR:-/homeassistant/opencode_beta}")],
  ["rootfs/opt/ha-lsp-server/server.js", patternChannel],
  ["rootfs/opt/ha-mcp-server/index.js", patternChannel],
  ["rootfs/opt/opencode-assist/install.py", source => source.replace('OWNER = "ha_opencode"', 'OWNER = "ha_opencode_beta"')],
  ["rootfs/opt/opencode-v2-homeassistant/mcp-startup.js", source => source
    .replace('state.channel !== "stable"', 'state.channel !== "beta"')
    .replaceAll('channel: "stable"', 'channel: "beta"')],
]);

test("beta carries every shared stable runtime/build file except reviewed divergences", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--",
    "ha_opencode/rootfs", "ha_opencode/compat", "ha_opencode/Dockerfile", "ha_opencode/.dockerignore",
  ], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 100, "the baseline inventory must not silently be empty");
  for (const file of files) {
    const relative = file.slice("ha_opencode/".length);
    const current = beta(relative); // Missing files fail, even for reviewed paths.
    const expected = reviewed.has(relative) ? reviewed.get(relative)(stable(relative)) : stable(relative);
    assert.equal(current, expected, `Unreviewed stable/beta divergence: ${relative}`);
  }
  for (const file of reviewed.keys()) {
    assert.ok(files.includes(`ha_opencode/${file}`), `Remove stale divergence entry: ${file}`);
    assert.notEqual(beta(file), stable(file), `Reconciled file no longer needs an exception: ${file}`);
  }
});

test("beta preserves stable project-upgrade repair and HAB cache integration", () => {
  const migration = "rootfs/usr/local/bin/opencode-v2-migrate.py";
  assert.equal(beta(migration), stable(migration));
  const server = "rootfs/opt/ha-mcp-server/index.js";
  const normalized = patternChannel(stable(server));
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
