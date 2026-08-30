const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON = path.join(__dirname, "..");
const ROOTFS = path.join(ADDON, "rootfs");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

describe("OpenCode V2 state isolation", () => {
  const environment = read(
    ROOTFS,
    "usr",
    "local",
    "lib",
    "opencode",
    "v2-environment.sh",
  );
  const init = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "init-opencode",
    "run",
  );
  const config = read(ADDON, "config.yaml");
  const dockerfile = read(ADDON, "Dockerfile");
  const migrator = read(
    ROOTFS,
    "usr",
    "local",
    "bin",
    "opencode-v2-migrate.py",
  );
  const runtime = read(ROOTFS, "usr", "local", "lib", "opencode", "runtime.sh");
  const v2Server = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "ha-opencode-v2-server",
    "run",
  );

  it("assigns persistent V2 state to one atomically selected generation", () => {
    assert.match(environment, /OPENCODE_V2_GENERATIONS_ROOT="\$\{OPENCODE_V2_ROOT\}\/generations"/);
    assert.match(environment, /OPENCODE_V2_CURRENT_FILE="\$\{OPENCODE_V2_ROOT\}\/current"/);
    for (const leaf of ["home", "config", "data", "state"]) {
      assert.match(environment, new RegExp(`OPENCODE_V2_[A-Z_]+=.?.*\\$\\{OPENCODE_V2_GENERATION_ROOT\\}/${leaf}`));
    }
    for (const leaf of ["cache", "work"]) {
      assert.match(environment, new RegExp(`OPENCODE_V2_[A-Z_]+=.?.*\\$\\{OPENCODE_V2_ROOT\\}/${leaf}`));
    }
    assert.match(environment, /OPENCODE_V2_ROOT="\$\{OPENCODE_V2_ROOT:-\/data\/v2\}"/);
  });

  it("exports a complete isolated XDG environment for V2 launchers", () => {
    assert.match(environment, /opencode_v2_select_generation \|\| return 1/);
    assert.match(environment, /export HOME="\$\{OPENCODE_V2_HOME\}"/);
    assert.match(environment, /export XDG_CONFIG_HOME="\$\{OPENCODE_V2_CONFIG_HOME\}"/);
    assert.match(environment, /export XDG_DATA_HOME="\$\{OPENCODE_V2_DATA_HOME\}"/);
    assert.match(environment, /export XDG_STATE_HOME="\$\{OPENCODE_V2_STATE_HOME\}"/);
    assert.match(environment, /export XDG_CACHE_HOME="\$\{OPENCODE_V2_CACHE_HOME\}"/);
  });

  it("prepares V2 roots before activation without replacing the V1 init environment", () => {
    assert.match(init, /source \/usr\/local\/lib\/opencode\/v2-environment\.sh/);
    assert.match(init, /opencode_v2_prepare_directories/);
    assert.match(init, /export HOME="\/data"/);
    assert.match(init, /export XDG_CONFIG_HOME="\/data\/\.config"/);
    assert.match(init, /if opencode_v2_prepare_directories; then/);
    assert.match(init, /V2_ROOTS_READY=false/);
  });

  it("fails closed on links and reserves every V2 path variable from user overrides", () => {
    assert.match(environment, /\[ -L "\$\{path\}" \]/);
    for (const name of [
      "OPENCODE_V2_ROOT",
      "OPENCODE_V2_HOME",
      "OPENCODE_V2_CONFIG_HOME",
      "OPENCODE_V2_DATA_HOME",
      "OPENCODE_V2_STATE_HOME",
      "OPENCODE_V2_CACHE_HOME",
      "OPENCODE_V2_WORK_ROOT",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      assert.match(init, new RegExp(`"${name}"`));
    }
  });

  it("runs the copy-on-write migration before V1 services are released", () => {
    assert.match(init, /opencode-v2-migrate\.py prepare/);
    assert.match(init, /--runtime-user opencode-v2/);
    assert.match(init, /continuing with the untouched V1 runtime and state/);
    assert.ok(
      init.indexOf("opencode-v2-migrate.py prepare") < init.indexOf("setsid node /usr/local/bin/discover-services.js"),
    );
  });

  it("runs the V2 converter as a dedicated identity with an allowlisted environment", () => {
    assert.match(dockerfile, /useradd --uid 60000 --gid opencode-v2/);
    assert.match(migrator, /def minimal_environment/);
    assert.match(migrator, /os\.setgroups\(\[\]\)/);
    assert.match(migrator, /os\.setuid\(uid\)/);
    assert.match(migrator, /require_source_isolation/);
    assert.doesNotMatch(migrator, /os\.environ\.items\(\)/);
  });

  it("selects the V2 native binary for the deployment CPU before migration", () => {
    assert.match(runtime, /opencode_select_v2_package_binary\(\)/);
    assert.match(runtime, /cli-linux-x64-baseline/);
    assert.match(runtime, /cli-linux-x64/);
    assert.match(runtime, /cli-linux-arm64/);
    assert.match(init, /V2_RUNTIME_BINARY_READY=false/);
    assert.match(init, /opencode_select_v2_package_binary/);
    assert.match(init, /V2_RUNTIME_BINARY_READY=true/);
    assert.match(init, /\[ "\$\{V2_RUNTIME_BINARY_READY\}" = "true" \]/);
  });

  it("probes the V2 version once inside disposable scrubbed roots", () => {
    assert.match(runtime, /opencode_v2_probe_version\(\)/);
    assert.match(runtime, /mktemp -d "\$\{work_root\}\/\.runtime-probe\.XXXXXXXX"/);
    assert.match(runtime, /env -i/);
    for (const leaf of ["home", "config", "data", "state", "cache", "tmp", "workspace"]) {
      assert.match(runtime, new RegExp(`\\$\\{probe_root\\}/${leaf}`));
    }
    assert.match(runtime, /OPENCODE_DISABLE_PROJECT_CONFIG="1"/);
    assert.match(runtime, /OPENCODE_DISABLE_EXTERNAL_SKILLS="1"/);
    assert.match(runtime, /OPENCODE_DISABLE_CLAUDE_CODE_SKILLS="1"/);
    assert.match(runtime, /"\$\{work_root\}"\/\.runtime-probe\.\*/);
    assert.match(runtime, /rm -rf -- "\$\{probe_root\}"/);
    assert.equal((init.match(/opencode_v2_probe_version/g) ?? []).length, 1);
    assert.doesNotMatch(init, /opencode_bin_runs "\$\{v2_bin\}"/);
    assert.doesNotMatch(init, /"\$\{v2_bin\}" --version/);
  });

  it("stages a root-owned native policy only after migration succeeds", () => {
    assert.match(init, /V2_STATE_READY=false/);
    assert.match(init, /V2_STATE_READY=true/);
    assert.match(init, /V2_RUNTIME_ROOT=\/run\/opencode-v2/);
    assert.match(init, /managed-config\.js/);
    assert.match(init, /--plugin-enabled false/);
    assert.match(init, /cp \/opt\/ha-mcp-server\/AGENTS\.md/);
    assert.match(init, /mkdir -p "\$\{V2_RUNTIME_ROOT\}\/config\/opencode" "\$\{V2_RUNTIME_ROOT\}\/home" "\$\{V2_RUNTIME_ROOT\}\/workspace"/);
    assert.match(init, /bashio::config 'restrict_sensitive_files' 'true'/);
    assert.ok(init.indexOf("V2_STATE_READY=true") < init.indexOf("managed-config.js"));
  });

  it("supervises V2 on loopback under uid 60000 with a scrubbed environment", () => {
    assert.match(v2Server, /opencode_v2_select_generation/);
    assert.match(v2Server, /exec setpriv/);
    assert.match(v2Server, /--reuid=60000/);
    assert.match(v2Server, /--regid=60000/);
    assert.match(v2Server, /--clear-groups/);
    assert.match(v2Server, /--no-new-privs/);
    assert.match(v2Server, /env -i/);
    assert.match(v2Server, /cd "\$\{V2_RUNTIME_ROOT\}\/workspace"/);
    assert.match(v2Server, /HOME="\$\{V2_RUNTIME_ROOT\}\/home"/);
    assert.match(v2Server, /OPENCODE_DISABLE_PROJECT_CONFIG=1/);
    assert.match(v2Server, /OPENCODE_DISABLE_EXTERNAL_SKILLS=1/);
    assert.match(v2Server, /OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1/);
    assert.match(v2Server, /OPENCODE_CONFIG="\$\{V2_RUNTIME_ROOT\}\/managed\.json"/);
    assert.match(v2Server, /--hostname 127\.0\.0\.1/);
    assert.match(v2Server, /--port 4100/);
    assert.doesNotMatch(v2Server, /source \/data\/\.env_vars/);
    assert.doesNotMatch(v2Server, /SUPERVISOR_TOKEN|HA_TOKEN|HA_ACCESS_TOKEN|PPQ_API_KEY/);
    assert.ok(fs.existsSync(path.join(
      ROOTFS,
      "etc",
      "s6-overlay",
      "s6-rc.d",
      "user",
      "contents.d",
      "ha-opencode-v2-server",
    )));
  });

  it("validates every selected generation leaf before exporting it", () => {
    assert.match(environment, /stat -c '%h'/);
    assert.match(environment, /"\$\{OPENCODE_V2_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_CONFIG_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_DATA_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_STATE_HOME\}"/);
  });

  it("excludes migration work and cache from Home Assistant backups", () => {
    assert.match(config, /^  - "v2\/work\/\*"$/m);
    assert.match(config, /^  - "v2\/cache\/\*"$/m);
  });
});
