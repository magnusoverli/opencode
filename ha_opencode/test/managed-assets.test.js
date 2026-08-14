// Runs the real deploy-opencode-assets.mjs against temporary directories.
//
// The rule that matters is the one about edits: these files live in a directory
// the user can open, and the add-on rewrites them on every start. Getting that
// wrong destroys someone's work silently, so each branch is exercised against
// the shipped script rather than a reimplementation of it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it, beforeEach, after } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const SCRIPT = path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "deploy-opencode-assets.mjs");
const SHIPPED_MCP_DIR = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server");
const AGENT_FILE = "home-assistant-read-only.md";

const scratchDirs = [];

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe(`${CHANNEL} managed skill deployment`, () => {
  let source;
  let target;
  let state;

  const run = () =>
    execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODE_ASSETS_SOURCE: source,
        OPENCODE_ASSETS_TARGET: target,
        OPENCODE_ASSETS_STATE: state,
      },
    });

  const skillTarget = () => path.join(target, "skills", "demo-skill", "SKILL.md");
  const otherSkillTarget = () => path.join(target, "skills", "other-skill", "SKILL.md");

  beforeEach(() => {
    const root = scratch("managed-assets-");
    source = path.join(root, "image");
    target = path.join(root, "config");
    state = path.join(root, "state.json");
    write(path.join(source, "skills", "demo-skill", "SKILL.md"), "v1 skill\n");
    write(path.join(source, "skills", "other-skill", "SKILL.md"), "v1 other\n");
    // Present in the image but never deployed: an agent in OpenCode's global
    // directory is selectable in sessions this add-on does not configure.
    write(path.join(source, "agents", "demo-agent.md"), "v1 agent\n");
  });

  it("deploys skills on a first start", () => {
    run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "v1 skill\n");
    assert.equal(fs.readFileSync(otherSkillTarget(), "utf8"), "v1 other\n");
    assert.ok(fs.existsSync(state));
  });

  it("never deploys agents into OpenCode's global agent directory", () => {
    run();
    assert.equal(fs.existsSync(path.join(target, "agents")), false);
  });

  it("is idempotent", () => {
    run();
    const output = run();
    assert.match(output, /2 already current/);
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "v1 skill\n");
  });

  it("updates an untouched copy when the image ships a newer one", () => {
    run();
    write(path.join(source, "skills", "demo-skill", "SKILL.md"), "v2 skill\n");
    const output = run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "v2 skill\n");
    assert.match(output, /1 updated/);
  });

  it("preserves a user-modified copy and warns instead of overwriting", () => {
    run();
    write(skillTarget(), "my own rules\n");
    write(path.join(source, "skills", "demo-skill", "SKILL.md"), "v2 skill\n");
    const output = run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "my own rules\n");
    assert.match(output, /Keeping your edited skills\/demo-skill\/SKILL\.md/);
  });

  it("keeps preserving an edited copy on every later start", () => {
    run();
    write(skillTarget(), "my own rules\n");
    write(path.join(source, "skills", "demo-skill", "SKILL.md"), "v2 skill\n");
    run();
    run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "my own rules\n");
  });

  it("adopts a pre-existing untracked copy rather than clobbering it", () => {
    // Someone dropped a file with this name in before the add-on ever ran.
    write(skillTarget(), "predates the add-on\n");
    const output = run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "predates the add-on\n");
    assert.match(output, /Keeping your edited/);
  });

  it("removes an unmodified asset the image no longer ships", () => {
    run();
    fs.rmSync(path.join(source, "skills", "demo-skill"), { recursive: true, force: true });
    const output = run();
    assert.equal(fs.existsSync(skillTarget()), false);
    assert.equal(fs.existsSync(path.join(target, "skills", "demo-skill")), false);
    assert.match(output, /1 removed/);
  });

  it("keeps an edited asset the image no longer ships", () => {
    run();
    write(skillTarget(), "my own rules\n");
    fs.rmSync(path.join(source, "skills", "demo-skill"), { recursive: true, force: true });
    run();
    assert.equal(fs.readFileSync(skillTarget(), "utf8"), "my own rules\n");
  });

  it("leaves unrelated files in the config directory alone", () => {
    write(path.join(target, "opencode.json"), "{}\n");
    write(path.join(target, "skills", "mine", "SKILL.md"), "hand written\n");
    run();
    assert.equal(fs.readFileSync(path.join(target, "opencode.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(target, "skills", "mine", "SKILL.md"), "utf8"), "hand written\n");
  });

  it("never fails the boot, even with an unreadable state file", () => {
    write(state, "not json at all");
    const output = run();
    assert.ok(fs.existsSync(skillTarget()));
    assert.match(output, /2 deployed/);
  });

  it("deploys the shipped skills into OpenCode's discovery path", () => {
    const root = scratch("managed-assets-real-");
    const realTarget = path.join(root, "config");
    execFileSync(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        OPENCODE_ASSETS_SOURCE: SHIPPED_MCP_DIR,
        OPENCODE_ASSETS_TARGET: realTarget,
        OPENCODE_ASSETS_STATE: path.join(root, "state.json"),
      },
    });
    const skills = fs
      .readdirSync(path.join(realTarget, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.ok(skills.includes("home-assistant-configuration"));
    assert.ok(skills.length >= 5);
    for (const skill of skills) {
      assert.ok(fs.existsSync(path.join(realTarget, "skills", skill, "SKILL.md")));
    }
    assert.equal(fs.existsSync(path.join(realTarget, "agents")), false);
    // The agent file still ships; ha-readonly reads its prompt straight from
    // the image rather than from a deployed copy.
    assert.ok(fs.existsSync(path.join(SHIPPED_MCP_DIR, "agents", AGENT_FILE)));
  });
});

describe(`${CHANNEL} deployment is wired into start-up`, () => {
  it("runs from the init oneshot", () => {
    const init = fs.readFileSync(
      path.join(ADDON_DIR, "rootfs", "etc", "s6-overlay", "s6-rc.d", "init-opencode", "run"),
      "utf8",
    );
    assert.match(init, /deploy-opencode-assets\.mjs/);
  });

  it("targets OpenCode's global config directory", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    assert.match(script, /\/data\/\.config\/opencode/);
    assert.match(script, /source: "skills", target: "skills"/);
    assert.ok(!/source: "agents"/.test(script), "agents must not be deployed globally");
  });
});
