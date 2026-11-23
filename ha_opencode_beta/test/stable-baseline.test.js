// Shared implementation matches stable 3.5.3. Only exact, reviewed channel
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
// #221 changes the request authority throughout these four modules. Pin both
// sides of the reviewed delta instead of ignoring whole files or duplicating
// the implementation here. Remove these pins when promoting the feature.
const lanAliases = new Map(Object.entries({
  "lan-config.js": ["dd9b59a529b3d11323821ddf9161ac7aa163ea0798eadcdec44d114673d61147", "059d91323f56af4e55775f3abeaa0c7048f03cc82de321a7ea1fc181dd9b2974"],
  "lan-server.js": ["47ea4d4407091a0e8e4e2422a3d3516ce346146325cdc36fad231bf97da23411", "c9b081f638fdd421e2f4d651247aa2c122c493a2e0430cefc81ab81a2e1a0fae"],
  "lan-proxy.js": ["84109171868443909a8ae83c7bb118784e494feb3f7fed87833b379ab6b9b5f8", "a282d2cf724aa947ac79505255589f6ac0a7a752fcd600642f296ae46feba7be"],
  "lan-pairing.js": ["be977ef7c61c714a5cc895efe59d9688e52e64a0792c4362907e2b04da62a811", "a6e57da173f5ccdbba2e66eb6feb2d6c61f948f65692a7861db5a8dddc2bc6e1"],
}).map(([name, hashes]) => [`rootfs/opt/opencode-v2-homeassistant/${name}`, hashes]));
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
    if (lanAliases.has(relative)) {
      assert.deepEqual([stable(relative), current].map(text => createHash("sha256").update(text).digest("hex")),
        lanAliases.get(relative), `Review the #221 changes to ${relative}`);
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
