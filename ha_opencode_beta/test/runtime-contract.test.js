// The add-on ships exactly one OpenCode build and runs only that one. That is a
// property of several files at once — the Dockerfile pin, the CI-read pin in
// build.yaml, and every script that builds a PATH — so it is asserted here
// rather than trusted to review.
//
// Scoped to the beta add-on, whose V2 runtime contract intentionally differs
// from the V1 stable add-on.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const ROOTFS = path.join(ADDON_DIR, "rootfs");

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

/** Every shipped shell script and s6 run file, as [relative path, contents]. */
function shellSources() {
  const roots = [
    path.join(ROOTFS, "usr", "local", "bin"),
    path.join(ROOTFS, "usr", "local", "lib", "opencode"),
    path.join(ROOTFS, "etc", "s6-overlay", "s6-rc.d"),
  ];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      const parent = entry.parentPath ?? entry.path ?? root;
      const full = path.join(parent, entry.name);
      if (!entry.isFile()) continue;
      const contents = fs.readFileSync(full);
      // Skip anything that is not text (none today, but the tree grows).
      if (contents.includes(0)) continue;
      files.push([path.relative(ADDON_DIR, full), contents.toString("utf8")]);
    }
  }
  return files;
}

describe(`${CHANNEL} runtime pin`, () => {
  const dockerfile = read(ADDON_DIR, "Dockerfile");
  const configYaml = read(ADDON_DIR, "config.yaml");
  const appArmor = read(ADDON_DIR, "apparmor.txt");
  const buildYaml = read(ADDON_DIR, "build.yaml");
  const v2BoundaryFixture = read(ADDON_DIR, "test", "v2-boundary-fixture.sh");
  const v2SelfTest = read(ROOTFS, "usr", "local", "bin", "opencode-v2-self-test");
  const smokeTest = read(ROOTFS, "usr", "local", "bin", "opencode-smoke-test");
  const v2Session = read(ROOTFS, "usr", "local", "bin", "opencode-v2-session");
  const initService = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
  const containerInit = read(ROOTFS, "opt", "opencode-v2-homeassistant", "container-init.c");
  const tuiLauncher = read(ROOTFS, "opt", "opencode-v2-homeassistant", "tui-launcher.c");
  const devcontainerAcceptance = read(ADDON_DIR, "..", "scripts", "devcontainer-acceptance.sh");

  const dockerfilePin = /^ARG OPENCODE_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlPin = /^\s*OPENCODE_VERSION:\s*"([^"]*)"/m.exec(buildYaml)?.[1];
  const dockerfileNodePin = /^ARG NODE_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlNodePin = /^\s*NODE_VERSION:\s*"([^"]*)"/m.exec(buildYaml)?.[1];
  const dockerfileV2Pin = /^ARG OPENCODE_V2_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlV2Pin = /^\s*OPENCODE_V2_VERSION:\s*"([^"]*)"/m.exec(buildYaml)?.[1];
  const v2Package = JSON.parse(
    read(ROOTFS, "opt", "opencode-v2-homeassistant", "package.json"),
  );
  const dockerfileOpenchamberPin = /^ARG OPENCHAMBER_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlOpenchamberPin = /^\s*OPENCHAMBER_VERSION:\s*"([^"]*)"/m.exec(buildYaml)?.[1];

  it("pins an exact OpenCode version in the Dockerfile", () => {
    assert.ok(dockerfilePin, "Dockerfile has no ARG OPENCODE_VERSION");
    assert.match(
      dockerfilePin,
      /^\d+\.\d+\.\d+$/,
      `OPENCODE_VERSION must be an exact version, got '${dockerfilePin}'`,
    );
  });

  it("pins the same version in build.yaml, which is what CI reads", () => {
    assert.ok(buildYamlPin, "build.yaml has no OPENCODE_VERSION");
    assert.equal(buildYamlPin, dockerfilePin);
  });

  it("copies one exact supported Node runtime into the Home Assistant base", () => {
    assert.match(dockerfileNodePin, /^24\.\d+\.\d+$/);
    assert.equal(buildYamlNodePin, dockerfileNodePin);
    assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-trixie-slim AS node-runtime/);
    assert.match(dockerfile, /test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/);
    assert.doesNotMatch(dockerfile, /^[ \t]+nodejs \\/m);
  });

  it("fails closed on architecture selection and executes both target runtimes", () => {
    assert.match(dockerfile, /Unsupported BUILD_ARCH: \$\{BUILD_ARCH:-unset\}/);
    assert.match(dockerfile, /test "\$\(opencode --version\)" = "\$\{OPENCODE_VERSION\}"/);
    assert.match(dockerfile, /opencode2 --version/);
  });

  it("pins the same exact OpenChamber version in the Dockerfile and build.yaml", () => {
    assert.ok(dockerfileOpenchamberPin, "Dockerfile has no ARG OPENCHAMBER_VERSION");
    assert.ok(buildYamlOpenchamberPin, "build.yaml has no OPENCHAMBER_VERSION");
    assert.match(dockerfileOpenchamberPin, /^\d+\.\d+\.\d+$/);
    assert.equal(buildYamlOpenchamberPin, dockerfileOpenchamberPin);
  });

  it("retains the certified V1 rollback runtime during migration", () => {
    assert.match(dockerfilePin, /^1\./);
  });

  it("pins one matching exact V2 CLI and plugin beta", () => {
    assert.match(dockerfileV2Pin, /^0\.0\.0-beta-\d+$/);
    assert.equal(buildYamlV2Pin, dockerfileV2Pin);
    assert.equal(v2Package.dependencies["@opencode-ai/cli"], dockerfileV2Pin);
    assert.equal(v2Package.dependencies["@opencode-ai/plugin"], dockerfileV2Pin);
  });

  it("installs and verifies the V2 runtime from its committed lock", () => {
    assert.match(dockerfile, /opencode-v2-homeassistant && npm ci --omit=dev/);
    assert.match(dockerfile, /@opencode-ai\/cli\/package\.json'\)\.version/);
    assert.match(dockerfile, /@opencode-ai\/plugin\/package\.json'\)\.version/);
    assert.match(dockerfile, /opencode2 --version/);
    assert.match(dockerfile, /\/usr\/local\/share\/opencode-v2-certified-version/);
    assert.match(dockerfile, /cli-linux-x64-baseline\/bin\/opencode2/);
    assert.match(dockerfile, /cli-linux-x64\/bin\/opencode2/);
    assert.match(dockerfile, /cli-linux-arm64\/bin\/opencode2/);
    for (const name of ["V2_INSTALL_PID", "MCP_INSTALL_PID", "LSP_INSTALL_PID"]) {
      assert.match(dockerfile, new RegExp(`wait "\\$\\{${name}\\}"`));
    }
  });

  it("fails the image build when the resolved runtime is not the pin", () => {
    assert.match(dockerfile, /opencode-ai\/package\.json'\)\.version/);
    assert.match(dockerfile, /OPENCODE_VERSION is \$\{OPENCODE_VERSION\}/);
  });

  it("records the certified version in the image for runtime code to read", () => {
    assert.match(dockerfile, /\/usr\/local\/share\/opencode-certified-version/);
    assert.match(
      read(ROOTFS, "usr", "local", "lib", "opencode", "runtime.sh"),
      /opencode_certified_version\(\)/,
    );
    assert.match(
      read(ROOTFS, "usr", "local", "lib", "opencode", "runtime.sh"),
      /opencode_v2_certified_version\(\)/,
    );
  });

  it("selects V2 for the default TUI and retains explicit V1 rollback", () => {
    const session = read(ROOTFS, "usr", "local", "bin", "opencode-session.sh");
    const serviceRoot = path.join(ROOTFS, "etc", "s6-overlay", "s6-rc.d");

    assert.match(configYaml, /terminal_runtime: "v2"/);
    assert.match(configYaml, /terminal_runtime: list\(v2\|v1\)/);
    assert.ok(configYaml.indexOf('terminal_runtime: "v2"') < configYaml.indexOf('interface_mode: "terminal"'));
    assert.match(initService, /SELECTED_INTERFACE_MODE=.*interface_mode/);
    assert.match(initService, /if \[ "\$\{TERMINAL_RUNTIME\}" = "v2" \]; then\s+INTERFACE_MODE="terminal"/);
    assert.match(initService, /OpenChamber is V1-only; V2 will serve the terminal/);
    assert.match(initService, /printf '%s\\n' "\$\{INTERFACE_MODE\}" > \/data\/\.interface_mode/);
    for (const service of [
      "ha-opencode",
      "ha-openchamber",
      "ha-openchamber-ingress",
      "ha-openchamber-lan",
    ]) {
      assert.match(read(serviceRoot, service, "run"), /cat \/data\/\.interface_mode/);
    }
    for (const service of [
      "ha-openchamber",
      "ha-openchamber-ingress",
      "ha-openchamber-lan",
      "ha-opencode-server",
    ]) {
      assert.match(read(serviceRoot, service, "run"), /cat \/data\/\.terminal_runtime/);
    }
    assert.match(session, /TERMINAL_RUNTIME=.*\.terminal_runtime/);
    assert.match(session, /exec \/usr\/local\/bin\/opencode-v2-session/);
    assert.match(session, /Current TUI: OpenCode V1 \$\{OPENCODE_VERSION\}/);
    assert.match(v2Session, /Current TUI: OpenCode V2 \$\{V2_VERSION\}/);
    assert.match(v2Session, /Rollback runtime retained: OpenCode V1 \$\{V1_VERSION\}/);
    assert.match(v2Session, /TUI runs as uid 60001; the V2 server runs as root/);
    assert.match(v2Session, /exec \/usr\/local\/bin\/opencode-v2-tui-launch \/run\/opencode-v2/);
  });

  it("uses the direct Home Assistant workspace without elevated mount privileges", () => {
    assert.match(configYaml, /privileged: \[\]/);
    assert.match(configYaml, /apparmor: true/);
    assert.doesNotMatch(appArmor, /capability sys_admin,/);
    assert.doesNotMatch(appArmor, /^\s*capability,\s*$/m);
    assert.doesNotMatch(appArmor, /^\s*ptrace,\s*$/m);
    assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/opencode-container-init"\]/);
    assert.doesNotMatch(containerInit, /X-mount\.idmap|\/usr\/bin\/mount|CAP_SYS_ADMIN/);
    assert.match(containerInit, /#define SOURCE_PATH "\/homeassistant"/);
    assert.match(containerInit, /v1_rollback_requested/);
    assert.match(containerInit, /\.terminal_runtime == \\\"v1\\\"/);
    for (const service of [
      "ha-opencode-v2-credential-broker",
      "ha-opencode-v2-mcp-proxy",
      "ha-opencode-v2-mcp-sidecar",
      "ha-opencode-v2-server",
    ]) {
      assert.match(containerInit, new RegExp(`"${service}"`));
    }
    assert.match(containerInit, /disable_v2_services\(\)/);
    const rollbackMigrationGate = initService.indexOf("OpenCode V2 migration is skipped during explicit V1 rollback");
    assert.ok(rollbackMigrationGate >= 0);
    assert.ok(rollbackMigrationGate < initService.indexOf("opencode-v2-migrate.py prepare"));
    assert.match(containerInit, /execve\(arguments\[0\], arguments, environ\)/);
  });

  it("attaches the V2 TUI through a credential-confined native launcher", () => {
    assert.match(dockerfile, /useradd --uid 60001 --gid opencode-v2-tui/);
    assert.match(tuiLauncher, /#define RUNTIME_UID 60001/);
    assert.match(tuiLauncher, /clearenv\(\)/);
    assert.match(tuiLauncher, /OPENCODE_PASSWORD/);
    assert.match(tuiLauncher, /PR_SET_DUMPABLE, 0/);
    assert.match(tuiLauncher, /PR_CAPBSET_DROP/);
    assert.match(tuiLauncher, /fstatat\(workspace, "\.opencode"/);
    assert.match(tuiLauncher, /OPENCODE_DISABLE_PROJECT_CONFIG/);
    assert.match(tuiLauncher, /OPENCODE_CONFIG/);
    assert.match(tuiLauncher, /LD_PRELOAD/);
    assert.match(tuiLauncher, /opencode-v2-non-dumpable\.so/);
    assert.match(tuiLauncher, /"\/usr\/local\/bin\/opencode2", "--server", SERVER_URL/);
    assert.doesNotMatch(tuiLauncher, /SUPERVISOR_TOKEN|HA_TOKEN|HA_ACCESS_TOKEN/);
    assert.match(
      read(ROOTFS, "opt", "opencode-v2-homeassistant", "secure-launcher.c"),
      /project \.opencode content is not allowed in the V2 server/,
    );
  });

  it("exercises the staged V2 Linux privilege boundary during the image build", () => {
    assert.match(dockerfile, /opencode-v2-launch/);
    assert.match(dockerfile, /secure-launcher\.c/);
    assert.match(v2BoundaryFixture, /NoNewPrivs:/);
    assert.match(v2BoundaryFixture, /managed-config\.js --restrict-sensitive-files false --plugin-enabled true/);
    assert.match(v2BoundaryFixture, /V2 server accepted project \.opencode content/);
    assert.match(v2BoundaryFixture, /OPENCODE_MCP_TOOL_PROFILE=full/);
    assert.match(v2BoundaryFixture, /opencode-v2-self-test --quiet/);
    assert.match(v2SelfTest, /PR_SET_DUMPABLE/);
    assert.match(v2SelfTest, /os\.O_NOFOLLOW/);
    assert.match(v2SelfTest, /urllib\.request\.ProxyHandler\(\{\}\)/);
    assert.match(v2SelfTest, /NoRedirectHandler/);
    assert.match(v2SelfTest, /signal\.alarm\(SELF_TEST_DEADLINE_SECONDS\)/);
    assert.match(v2SelfTest, /fnmatch\.fnmatchcase/);
    assert.match(v2SelfTest, /agent\.get\("permissions"\)/);
    assert.match(v2SelfTest, /homeassistant_remember_decision/);
    assert.match(v2SelfTest, /mcp-enabled/);
    assert.doesNotMatch(v2SelfTest, /\/api\/session|method="DELETE"/);
    assert.match(smokeTest, /timeout --signal=TERM --kill-after=10s 60s/);
    assert.doesNotMatch(devcontainerAcceptance, /curl[^\n]*-u/);
    assert.match(
      read(ROOTFS, "opt", "opencode-v2-homeassistant", "secure-launcher.c"),
      /"\/usr\/local\/bin\/opencode2", "serve"/,
    );
    assert.match(dockerfile, /cc -shared -fPIC/);
    assert.match(dockerfile, /opencode-v2-non-dumpable\.so/);
    assert.match(dockerfile, /source=test\/v2-boundary-fixture\.sh/);
    assert.match(dockerfile, /FROM runtime AS boundary-test/);
    assert.match(dockerfile, /FROM runtime AS final/);
    assert.match(dockerfile, /timeout --signal=TERM --kill-after=10s 240s/);
    assert.doesNotMatch(dockerfile, /Skipping architecture-neutral V2 boundary fixture/);
  });

  it("declares a complete s6 service graph", () => {
    const graph = path.join(ROOTFS, "etc", "s6-overlay", "s6-rc.d");
    const services = fs
      .readdirSync(graph, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "user")
      .map((entry) => entry.name);

    for (const service of services) {
      assert.ok(fs.existsSync(path.join(graph, service, "type")), `${service} has no type`);
      const dependencies = path.join(graph, service, "dependencies.d");
      if (!fs.existsSync(dependencies)) continue;
      for (const dependency of fs.readdirSync(dependencies)) {
        assert.ok(
          fs.existsSync(path.join(graph, dependency, "type")),
          `${service} depends on missing service ${dependency}`,
        );
      }
    }

    for (const service of fs.readdirSync(path.join(graph, "user", "contents.d"))) {
      assert.ok(fs.existsSync(path.join(graph, service, "type")), `user bundle includes missing service ${service}`);
    }
  });

  it("reserves supervised lifecycle and Ingress checks for the devcontainer", () => {
    assert.doesNotMatch(v2BoundaryFixture, /kill -KILL "\$\{SIDECAR_PID\}"/);
    assert.match(devcontainerAcceptance, /s6-svc -k \/run\/service\/ha-opencode-v2-mcp-sidecar/);
    assert.doesNotMatch(devcontainerAcceptance, /s6-svc -d \/run\/service\/ha-opencode-v2-mcp-sidecar/);
    assert.match(devcontainerAcceptance, /new_sidecar_pid.*old_sidecar_pid/);
    assert.match(devcontainerAcceptance, /http:\/\/127\.0\.0\.1:8123\/api\/hassio_ingress\/\$\{INGRESS_TOKEN\}\//);
    assert.match(devcontainerAcceptance, /\/usr\/local\/bin\/opencode-smoke-test/);
  });

  it("bounds every process in the in-image migration fixture", () => {
    assert.match(dockerfile, /curl -fsS --connect-timeout 1 --max-time 2/);
    assert.match(dockerfile, /kill -KILL "\$\{V1_SERVER_PID\}"/);
    assert.match(
      dockerfile,
      /timeout --signal=TERM --kill-after=10s 180s python3 \/usr\/local\/bin\/opencode-v2-migrate\.py/,
    );
    assert.match(
      dockerfile,
      /timeout --signal=TERM --kill-after=5s 30s opencode db/,
    );
  });

  it("ships OpenSSH client tools for Git SSH remotes", () => {
    assert.match(dockerfile, /^\s*openssh-client \\/m);
    for (const command of ["ssh", "ssh-keygen", "ssh-keyscan"]) {
      assert.match(dockerfile, new RegExp(`command -v ${command} >/dev/null`));
    }
  });

  it("uses current Supervisor map types for local app development", () => {
    const config = read(ADDON_DIR, "config.yaml");

    assert.match(config, /^  - type: local_apps$/m);
    assert.match(config, /^  - type: all_app_configs$/m);
    assert.doesNotMatch(config, /^  - type: (addons|all_addon_configs)$/m);
  });
});

describe(`${CHANNEL} bundled runtime precedence`, () => {
  const sources = shellSources();

  it("never installs a rolling OpenCode at runtime", () => {
    for (const [file, contents] of sources) {
      assert.ok(
        !/opencode-ai@latest/.test(contents),
        `${file} still installs opencode-ai@latest`,
      );
      assert.ok(
        !/npm install -g opencode-ai/.test(contents),
        `${file} still installs opencode-ai from npm at runtime`,
      );
    }
  });

  it("ships no background updater", () => {
    assert.equal(
      fs.existsSync(path.join(ROOTFS, "usr", "local", "bin", "opencode-update.sh")),
      false,
    );
  });

  it("never puts the persistent npm prefix ahead of the image binary on PATH", () => {
    for (const [file, contents] of sources) {
      for (const line of contents.split("\n")) {
        if (!/^\s*(export\s+)?PATH=/.test(line) && !/printf 'export PATH=/.test(line)) continue;
        assert.ok(
          !/npm-global/.test(line) && !/NPM_CONFIG_PREFIX\}?\/bin/.test(line),
          `${file} puts the persistent npm prefix on PATH: ${line.trim()}`,
        );
      }
    }
  });

  it("disables OpenCode's own auto-update everywhere a session can start", () => {
    const mustDisable = [
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run"),
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "ha-opencode", "run"),
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "ha-opencode-server", "run"),
      path.join("rootfs", "etc", "s6-overlay", "s6-rc.d", "ha-openchamber", "run"),
      path.join("rootfs", "usr", "local", "bin", "opencode-session.sh"),
      path.join("rootfs", "usr", "local", "bin", "ha-readonly"),
    ];
    for (const relative of mustDisable) {
      assert.match(
        read(ADDON_DIR, relative),
        /OPENCODE_DISABLE_AUTOUPDATE=true/,
        `${relative} does not disable OpenCode auto-update`,
      );
    }
    assert.match(
      read(ROOTFS, "opt", "opencode-v2-homeassistant", "secure-launcher.c"),
      /OPENCODE_DISABLE_AUTOUPDATE.*true/,
    );
  });

  it("tells OpenChamber the certified runtime cannot be upgraded in place", () => {
    const openchamber = read(
      ROOTFS,
      "etc",
      "s6-overlay",
      "s6-rc.d",
      "ha-openchamber",
      "run",
    );

    assert.match(openchamber, /OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR="\/usr\/local\/bin"/);
    assert.match(openchamber, /OPENCHAMBER_BIN="\/usr\/local\/bin\/openchamber"/);
  });

  it("carries no update-policy option or plumbing", () => {
    assert.ok(!/opencode_update_policy/.test(read(ADDON_DIR, "config.yaml")));
    assert.ok(!/opencode_update_policy/.test(read(ADDON_DIR, "translations", "en.yaml")));
    for (const [file, contents] of sources) {
      // The init service still recognises a persisted legacy value so it can
      // log the migration notice; nothing else may branch on one.
      if (file.endsWith(path.join("init-opencode", "run"))) continue;
      assert.ok(
        !/OPENCODE_UPDATE_POLICY/.test(contents),
        `${file} still branches on the removed update policy`,
      );
    }
  });

  it("treats a persisted legacy 'latest' policy as bundled and says so", () => {
    const init = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
    // The marker every previous version wrote is the reliable evidence; the
    // saved options file is only a fallback, because the Supervisor drops keys
    // the current schema no longer declares.
    assert.match(init, /cat \/data\/\.opencode_update_policy/);
    assert.match(init, /jq -r '\.opencode_update_policy \/\/ empty' \/data\/options\.json/);
    assert.match(init, /LEGACY_UPDATE_POLICY.*=.*"latest"/);
    // The old install is the user's data. It stops being used; it is not deleted.
    assert.ok(!/rm -rf.*npm-global/.test(init));
  });
});

describe(`${CHANNEL} generated OpenCode configuration contract`, () => {
  const template = JSON.parse(read(ROOTFS, "opt", "ha-mcp-server", "opencode-ha.json"));

  it("runs the bundled MCP server and language server", () => {
    assert.deepEqual(template.mcp.homeassistant.command, ["node", "/opt/ha-mcp-server/index.js"]);
    assert.deepEqual(template.mcp.homeassistant_native.command, [
      "node",
      "/opt/ha-mcp-server/ha-native-mcp-proxy.js",
      "assist",
    ]);
    assert.deepEqual(template.lsp["ha-yaml"].command, [
      "node",
      "/opt/ha-lsp-server/server.js",
      "--stdio",
    ]);
    assert.deepEqual(template.formatter.prettier.command, ["prettier", "--write", "$FILE"]);
  });

  it("keeps the native MCP bridge opt-in", () => {
    assert.equal(template.mcp.homeassistant_native.enabled, false);
  });

  it("loads the core MCP instructions", () => {
    assert.ok(template.instructions.includes("/opt/ha-mcp-server/MCP_CORE_INSTRUCTIONS.md"));
  });

  it("asks before edits and before mutating shell commands", () => {
    assert.equal(template.permission.edit, "ask");
    for (const pattern of ["yq -i*", "sed -i*", "tee *", "rm *", "mv *"]) {
      assert.equal(
        template.permission.bash[pattern],
        "ask",
        `permission.bash['${pattern}'] should stay 'ask'`,
      );
    }
  });

  it("names every profile instruction file the init service can select", () => {
    const init = read(ROOTFS, "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run");
    assert.match(init, /MCP_PROFILE_\$\(echo "\$\{MCP_TOOL_PROFILE\}"/);
    for (const profile of ["COMPACT", "CONFIGURATION", "FULL"]) {
      assert.ok(
        fs.existsSync(path.join(ROOTFS, "opt", "ha-mcp-server", `MCP_PROFILE_${profile}.md`)),
        `MCP_PROFILE_${profile}.md is missing`,
      );
    }
  });
});
