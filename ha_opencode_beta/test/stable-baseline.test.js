// Shared implementation matches stable 3.5.4. Only exact, reviewed channel
// substitutions are permitted; new feature differences need explicit review.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const repo = resolve(__dirname, "../..");
const beta = file => readFileSync(join(repo, "ha_opencode_beta", file), "utf8").replace(/\r\n/g, "\n");
const stable = file => readFileSync(join(repo, "ha_opencode", file), "utf8").replace(/\r\n/g, "\n");
const patternChannel = source => source.replace("/main/ha_opencode/rootfs/", "/main/ha_opencode_beta/rootfs/");
// Reviewed #45 reporting delta. Pin both sides until the next stable promotion.
const reportingDelta = new Map(Object.entries({
  "ha-native-mcp-proxy.js": ["5ba01a5c0c78c7b9c5a05bfca15698ecc57ca3b126bd0d6d505151ded3d18f51", "5dee586d95a3b31c187c054cdb0c261b2ade4f9da56c9dd0eb625bdd20ef6db9"],
  "lib/agent-capabilities.js": ["d6953e68b0aa457924e3351b21fea519422c073386937103e6531ab6a9b8ae83", "e88697a86dc443c52eb630dc1751ebdd0ba6b310f42a8d0522a2f24618aec41f"],
  "lib/ha-native-mcp.js": ["fd1b402f2901bf4c102eda05e051cf5d5b13cfeac9dcc79592551209f5a8d959", "dc3dfec45a39d183f56b30d463d158de186cf59eb3ebd2f08285a2f200e2bb59"],
  "test/agent-capabilities.test.js": ["c2112f42136a9aa9026cc22ab777298cb131692fec4469d1fe871022b58cb0f4", "3899c24a9d11368140c5217f5158e42841be828611b22492287ad4701481006b"],
}).map(([file, hashes]) => [`rootfs/opt/ha-mcp-server/${file}`, hashes]));
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
    if (reportingDelta.has(relative)) {
      assert.deepEqual([stable(relative), current].map(text => createHash("sha256").update(text).digest("hex")),
        reportingDelta.get(relative), `Review the #45 changes in ${relative}`);
      continue;
    }
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
