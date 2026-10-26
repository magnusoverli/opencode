const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const addon = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(addon, file), "utf8");
const { parseDocument } = createRequire(path.join(addon, "rootfs/opt/ha-mcp-server/package.json"))("yaml");
const yaml = file => {
  const document = parseDocument(read(file), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS();
};

test("stable promotion retains stable identity, storage defaults and optional speech isolation", () => {
  const config = yaml("config.yaml");
  assert.equal(config.name, "OpenCode");
  assert.equal(config.slug, "ha_opencode");
  assert.equal(config.image, "ghcr.io/magnusoverli/ha_opencode");
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.equal(config.panel_title, "OpenCode");
  assert.equal(config.options.openchamber_allow_remote_speech, false);
  assert.equal(config.schema.openchamber_allow_remote_speech, "bool?");
  assert.equal(yaml("translations/en.yaml").configuration.native_ha_mcp_enabled.name, "Home Assistant native tools");
  const sidecar = read("rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run");
  assert.match(sidecar, /^\s+ADDON_CHANNEL=stable \\$/m);
  assert.match(sidecar, /OPENCODE_DECISION_NOTES_DIR:-\/homeassistant\/opencode\}/);
  assert.doesNotMatch(sidecar, /opencode_beta/);
  assert.match(read("apparmor.txt"), /profile ha_opencode flags=/);
  assert.match(read("rootfs/opt/opencode-assist/install.py"), /^OWNER = "ha_opencode"$/m);
  assert.match(read("rootfs/opt/opencode-v2-homeassistant/mcp-startup.js"), /state\.channel !== "stable"/);
});

test("stable promotion aligns the native runtime and immutable UI pins", () => {
  const build = yaml("build.yaml");
  const pkg = JSON.parse(read("rootfs/opt/opencode-v2-homeassistant/package.json"));
  const lock = JSON.parse(read("rootfs/opt/opencode-v2-homeassistant/package-lock.json"));
  assert.equal(build.args.OPENCODE_V2_VERSION, "2.1.4");
  assert.equal(pkg.dependencies["@opencode/cli"], build.args.OPENCODE_V2_VERSION);
  assert.equal(pkg.dependencies["@opencode/plugin"], build.args.OPENCODE_V2_VERSION);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(pkg.devDependencies["opencode-upgrade-previous"], "npm:@opencode/cli@2.0.26");
  assert.equal(pkg.devDependencies["opencode-stable-previous"], "npm:@opencode/cli@2.1.2");
  assert.equal(build.args.OPENCHAMBER_VERSION, "2.5.2");
  assert.equal(build.args.OPENCHAMBER_REVISION, "c4919abc1e7a0a3beeaa126666487806bf79cfe0");
  const docker = read("Dockerfile");
  assert.ok(docker.includes(`ARG OPENCODE_V2_VERSION=${build.args.OPENCODE_V2_VERSION}`));
  assert.ok(docker.includes(`ARG OPENCHAMBER_VERSION=${build.args.OPENCHAMBER_VERSION}`));
  assert.ok(docker.includes(`ARG OPENCHAMBER_REVISION=${build.args.OPENCHAMBER_REVISION}`));
  assert.ok(docker.includes("ARG ADDON_CHANNEL=stable"));
});

test("stable promotion preserves the reviewed Zigporter compatibility overlay and upgrade coverage", () => {
  const docker = read("Dockerfile");
  assert.ok(docker.includes("COPY compat/zigporter /tmp/zigporter-compat"));
  assert.ok(docker.includes("/tmp/zigporter-compat/apply_patch.py"));
  assert.ok(docker.includes("/tmp/zigporter-compat/test_compat.py"));
  assert.ok(fs.existsSync(path.join(addon, "compat/zigporter/manifest.json")));
  const migration = read("rootfs/usr/local/bin/opencode-v2-migrate.py");
  assert.match(migration, /^V2_UPGRADE_SOURCES = .*"2\.0\.26"/m);
  assert.match(migration, /^V2_UPGRADE_SOURCES = .*"2\.1\.2"/m);
  assert.match(migration, /^V2_UPGRADE_TARGET = "2\.1\.4"$/m);
  assert.match(read("rootfs/etc/s6-overlay/s6-rc.d/init-opencode/run"), /agents-importer\.js "\$\{V2_CONFIG_TEMP\}"/);
});

test("stable promotion documents backup-based rollback and the delivered feature scope", () => {
  const docs = read("DOCS.md");
  assert.ok(docs.includes("Stable **3.3.0**"));
  assert.ok(docs.includes("Rollback requires the pre-upgrade Home Assistant backup"));
  assert.ok(docs.includes("/config/opencode/decisions.yaml"));
  assert.ok(docs.includes("2 MiB"));
  assert.ok(docs.includes("not guaranteed inclusion"));
  assert.match(docs, /Project-scoped agents, separate\s+decision archives and automatic relevance injection are not added/);
  assert.ok(docs.includes("OpenChamber's separate callback/tool integration"));
});
