// The add-on ships exactly one OpenCode build and runs only that one. That is a
// property of several files at once — the Dockerfile pin, the CI-read pin in
// build.yaml, and every script that builds a PATH — so it is asserted here
// rather than trusted to review.
//
// Scoped to the add-on folder this test file ships in, so the copy promoted to
// stable checks stable and the beta copy checks beta.

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
  const buildYaml = read(ADDON_DIR, "build.yaml");

  const dockerfilePin = /^ARG OPENCODE_VERSION=(.+)$/m.exec(dockerfile)?.[1]?.trim();
  const buildYamlPin = /^\s*OPENCODE_VERSION:\s*"([^"]*)"/m.exec(buildYaml)?.[1];
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

  it("pins the same exact OpenChamber version in the Dockerfile and build.yaml", () => {
    assert.ok(dockerfileOpenchamberPin, "Dockerfile has no ARG OPENCHAMBER_VERSION");
    assert.ok(buildYamlOpenchamberPin, "build.yaml has no OPENCHAMBER_VERSION");
    assert.match(dockerfileOpenchamberPin, /^\d+\.\d+\.\d+$/);
    assert.equal(buildYamlOpenchamberPin, dockerfileOpenchamberPin);
  });

  it("stays on the certified V1 line", () => {
    // V2 adoption is governed by OPENCODE_V2_FUTURE.md and its release gates,
    // not by editing a pin.
    assert.match(dockerfilePin, /^1\./);
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
