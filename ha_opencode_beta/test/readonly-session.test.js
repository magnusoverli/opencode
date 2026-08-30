// What `ha-readonly` actually hands to OpenCode is a merged JSON document built
// at launch, not the overlay file on disk — so the overlay is checked for
// intent and the launcher is executed for the result. The launcher's
// --print-config path does exactly what the real path does and then stops
// before exec'ing OpenCode, which is what makes this testable off-device.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it, before, after } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const MCP_DIR = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server");
const OVERLAY = path.join(MCP_DIR, "opencode-readonly.json");
const LAUNCHER = path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "ha-readonly");

const overlay = JSON.parse(fs.readFileSync(OVERLAY, "utf8"));

function hasTool(name) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe(`${CHANNEL} read-only overlay`, () => {
  it("starts the read-only agent and defines it", () => {
    assert.equal(overlay.default_agent, "home-assistant-read-only");
    assert.ok(overlay.agent["home-assistant-read-only"]);
    assert.equal(overlay.agent["home-assistant-read-only"].mode, "primary");
  });

  it("forces the compact MCP tool profile", () => {
    assert.equal(
      overlay.mcp.homeassistant.environment.OPENCODE_MCP_TOOL_PROFILE,
      "compact",
    );
  });

  it("disables the native MCP bridge, whose tools the profile does not filter", () => {
    assert.equal(overlay.mcp.homeassistant_native.enabled, false);
  });

  it("denies edit, bash, task and lsp at both session and agent level", () => {
    for (const permission of [overlay.permission, overlay.agent["home-assistant-read-only"].permission]) {
      assert.equal(permission.edit, "deny");
      assert.equal(permission.task, "deny");
      assert.equal(permission.lsp, "deny");
      assert.equal(permission.bash["*"], "deny");
      for (const value of Object.values(permission.bash)) assert.equal(value, "deny");
    }
  });

  it("denies the sensitive reads unconditionally", () => {
    for (const permission of [overlay.permission, overlay.agent["home-assistant-read-only"].permission]) {
      assert.equal(permission.read["*"], "allow");
      for (const pattern of [
        "*secrets.yaml",
        "*.storage/*",
        "*.cloud/*",
        "*ssl/*",
        "*.key",
        "*.pem",
      ]) {
        assert.equal(permission.read[pattern], "deny", `read['${pattern}'] is not denied`);
      }
    }
  });

  it("agrees with the agent markdown it takes its prompt from", () => {
    // The markdown is the readable source; the overlay is what is guaranteed to
    // be in force. Two statements of one contract is a drift risk, so they are
    // held equal here.
    const markdown = fs.readFileSync(
      path.join(MCP_DIR, "agents", "home-assistant-read-only.md"),
      "utf8",
    );
    const agent = overlay.agent["home-assistant-read-only"];
    assert.match(markdown, new RegExp(`mode: ${agent.mode}`));
    for (const key of Object.keys(agent.permission)) {
      assert.match(markdown, new RegExp(`^\\s*${key}:`, "m"), `agent file has no ${key} permission`);
    }
    for (const tool of Object.keys(agent.tools)) {
      assert.match(markdown, new RegExp(`^\\s*${tool}: false$`, "m"), `agent file still enables ${tool}`);
    }
  });
});

describe(`${CHANNEL} read-only launcher`, { skip: !hasTool("jq") && "jq is not installed" }, () => {
  let scratch;
  let effective;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ha-readonly-"));

    // A generated configuration shaped exactly like the one the init service
    // writes for the widest-open settings: full MCP profile, native bridge on,
    // "ask" on the mutating shell commands.
    const generated = JSON.parse(fs.readFileSync(path.join(MCP_DIR, "opencode-ha.json"), "utf8"));
    generated.mcp.homeassistant.enabled = true;
    generated.mcp.homeassistant.environment.OPENCODE_MCP_TOOL_PROFILE = "full";
    generated.mcp.homeassistant_native.enabled = true;
    generated.instructions = [
      ...generated.instructions,
      "/opt/ha-mcp-server/MCP_PROFILE_FULL.md",
      "/homeassistant/AGENTS.local.md",
    ];
    const generatedPath = path.join(scratch, "opencode.json");
    fs.writeFileSync(generatedPath, JSON.stringify(generated, null, 2));

    effective = JSON.parse(
      execFileSync("bash", [LAUNCHER, "--print-config"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HA_READONLY_OVERLAY: OVERLAY,
          HA_READONLY_CONFIG: generatedPath,
          HA_READONLY_AGENT: path.join(MCP_DIR, "agents", "home-assistant-read-only.md"),
          TMPDIR: scratch,
          HOME: scratch,
        },
      }),
    );
  });

  after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps everything a normal session needs to work", () => {
    assert.deepEqual(effective.mcp.homeassistant.command, ["node", "/opt/ha-mcp-server/index.js"]);
    assert.equal(effective.mcp.homeassistant.enabled, true);
    assert.ok(effective.lsp["ha-yaml"]);
    assert.ok(effective.formatter.prettier);
    assert.equal(effective.permission.external_directory["/homeassistant"], "allow");
  });

  it("forces the compact profile and switches off native MCP", () => {
    assert.equal(effective.mcp.homeassistant.environment.OPENCODE_MCP_TOOL_PROFILE, "compact");
    assert.equal(effective.mcp.homeassistant_native.enabled, false);
    // The token substitution the MCP server needs must survive the merge.
    assert.equal(
      effective.mcp.homeassistant.environment.SUPERVISOR_TOKEN,
      "{env:SUPERVISOR_TOKEN}",
    );
  });

  it("swaps the profile instruction for the one that matches", () => {
    assert.ok(effective.instructions.includes("/opt/ha-mcp-server/MCP_PROFILE_COMPACT.md"));
    assert.ok(!effective.instructions.includes("/opt/ha-mcp-server/MCP_PROFILE_FULL.md"));
    assert.equal(
      new Set(effective.instructions).size,
      effective.instructions.length,
      "instructions contains duplicates",
    );
  });

  it("denies every bash pattern, including the ones the generated config only asked about", () => {
    const bash = effective.permission.bash;
    assert.equal(bash["*"], "deny");
    for (const pattern of ["yq -i*", "sed -i*", "tee *", "rm *", "mv *"]) {
      assert.equal(bash[pattern], "deny", `bash['${pattern}'] survived as non-deny`);
    }
    for (const [pattern, value] of Object.entries(bash)) {
      assert.equal(value, "deny", `bash['${pattern}'] is '${value}'`);
    }
  });

  it("denies edits, subagents and the LSP tool", () => {
    assert.equal(effective.permission.edit, "deny");
    assert.equal(effective.permission.task, "deny");
    assert.equal(effective.permission.lsp, "deny");
  });

  it("denies sensitive reads even when the add-on has the restriction turned off", () => {
    // The generated config above carries no permission.read at all, which is
    // what `restrict_sensitive_files: false` produces.
    assert.equal(effective.permission.read["*secrets.yaml"], "deny");
    assert.equal(effective.permission.read["*.storage/*"], "deny");
    assert.equal(effective.permission.read["*"], "allow");
  });

  it("starts the read-only agent", () => {
    assert.equal(effective.default_agent, "home-assistant-read-only");
    assert.ok(effective.agent["home-assistant-read-only"]);
    assert.match(fs.readFileSync(LAUNCHER, "utf8"), /exec opencode --agent "\$\{AGENT_NAME\}"/);
  });

  it("injects the agent prompt from the markdown, frontmatter stripped", () => {
    const prompt = effective.agent["home-assistant-read-only"].prompt;
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.startsWith("# Home Assistant read-only session"));
    assert.ok(prompt.includes("home-assistant-troubleshooting"));
    assert.ok(!prompt.includes("mode: primary"), "frontmatter leaked into the prompt");
    assert.ok(!prompt.startsWith("---"), "frontmatter leaked into the prompt");
  });

  it("does not rely on an agent file being deployed anywhere", () => {
    // An agent in OpenCode's global directory is selectable in sessions that
    // never apply this overlay, where the MCP profile would still be the user's.
    const deploy = fs.readFileSync(
      path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "deploy-opencode-assets.mjs"),
      "utf8",
    );
    assert.ok(!/target: "agents"/.test(deploy));
  });

  it("refuses to start when the overlay is missing", () => {
    assert.throws(() =>
      execFileSync("bash", [LAUNCHER, "--print-config"], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          HA_READONLY_OVERLAY: path.join(scratch, "does-not-exist.json"),
          TMPDIR: scratch,
          HOME: scratch,
        },
      }),
    );
  });
});
