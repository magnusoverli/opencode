// Skills and agents are plain markdown that OpenCode discovers by convention.
// Nothing validates their frontmatter until a session tries to load them, and a
// skill with a malformed name is simply absent — no error, no log line, just a
// model that never gets the guidance. So validate the shipped files here.
//
// Frontmatter rules are OpenCode's, from https://opencode.ai/docs/skills and
// https://opencode.ai/docs/agents.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const MCP_DIR = path.join(ADDON_DIR, "rootfs", "opt", "ha-mcp-server");
const SKILLS_DIR = path.join(MCP_DIR, "skills");
const AGENTS_DIR = path.join(MCP_DIR, "agents");

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EXPECTED_SKILLS = [
  "home-assistant-configuration",
  "home-assistant-troubleshooting",
  "home-assistant-dashboard-ui",
  "home-assistant-zigbee-esphome",
  "home-assistant-development",
];

/**
 * Minimal frontmatter reader. Deliberately not a YAML parser: these files must
 * parse with the simplest possible reading, because that is the shape every
 * consumer agrees on.
 */
function frontmatter(contents) {
  assert.ok(contents.startsWith("---\n"), "file does not open with YAML frontmatter");
  const end = contents.indexOf("\n---\n", 3);
  assert.ok(end !== -1, "frontmatter is not terminated");
  const block = contents.slice(4, end + 1);
  const body = contents.slice(end + 5);

  const fields = {};
  let currentKey = null;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (topLevel && !line.startsWith(" ")) {
      currentKey = topLevel[1];
      fields[currentKey] = topLevel[2] === "" ? {} : topLevel[2];
      continue;
    }
    if (currentKey && typeof fields[currentKey] === "object") {
      fields[currentKey].__raw = `${fields[currentKey].__raw ?? ""}${line}\n`;
    }
  }
  return { fields, block, body };
}

describe(`${CHANNEL} skills`, () => {
  it("ships exactly the documented set", () => {
    const found = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(found, [...EXPECTED_SKILLS].sort());
  });

  for (const skill of EXPECTED_SKILLS) {
    describe(skill, () => {
      const file = path.join(SKILLS_DIR, skill, "SKILL.md");
      const contents = fs.readFileSync(file, "utf8");
      const { fields, body } = frontmatter(contents);

      it("declares a name matching its directory and OpenCode's pattern", () => {
        assert.equal(fields.name, skill);
        assert.match(fields.name, SKILL_NAME_PATTERN);
        assert.ok(fields.name.length >= 1 && fields.name.length <= 64);
      });

      it("declares a description specific enough to select on", () => {
        assert.equal(typeof fields.description, "string");
        assert.ok(fields.description.length >= 40, "description is too vague to route on");
        assert.ok(fields.description.length <= 1024, "description exceeds OpenCode's limit");
        // A description that never says when to reach for the skill cannot be
        // selected against; every one of ours states the trigger.
        assert.match(fields.description, /Load this|Covers/);
      });

      it("has a body", () => {
        assert.ok(body.trim().length > 200);
      });
    });
  }

  it("keeps the unconditional rules in AGENTS.md, not in a skill", () => {
    const agents = fs.readFileSync(path.join(MCP_DIR, "AGENTS.md"), "utf8");
    assert.match(agents, /## CRITICAL: User Consent and Scope Rules/);
    assert.match(agents, /## Safety Guidelines/);
    assert.match(agents, /## RESTRICTED: Internal Home Assistant Directories/);
    assert.match(agents, /NEVER expose or display contents of `secrets\.yaml`/);
  });

  it("maps every skill from AGENTS.md so it stays discoverable", () => {
    const agents = fs.readFileSync(path.join(MCP_DIR, "AGENTS.md"), "utf8");
    for (const skill of EXPECTED_SKILLS) {
      assert.ok(agents.includes(skill), `AGENTS.md does not mention ${skill}`);
    }
  });

  it("keeps the live help injection markers AGENTS.md deployment depends on", () => {
    const agents = fs.readFileSync(path.join(MCP_DIR, "AGENTS.md"), "utf8");
    for (const marker of [
      "<!-- HAB_LIVE_HELP_START -->",
      "<!-- HAB_LIVE_HELP_END -->",
      "<!-- ZIGPORTER_LIVE_HELP_START -->",
      "<!-- ZIGPORTER_LIVE_HELP_END -->",
    ]) {
      assert.ok(agents.includes(marker), `AGENTS.md lost ${marker}`);
    }
  });
});

describe(`${CHANNEL} read-only agent`, () => {
  const file = path.join(AGENTS_DIR, "home-assistant-read-only.md");
  const contents = fs.readFileSync(file, "utf8");
  const { fields, block, body } = frontmatter(contents);

  it("is a primary agent with a description", () => {
    assert.equal(fields.mode, "primary");
    assert.equal(typeof fields.description, "string");
    assert.ok(fields.description.length > 40);
  });

  it("denies edit, bash, task and lsp", () => {
    const permission = fields.permission?.__raw ?? "";
    assert.match(permission, /^\s{2}edit:\s*deny$/m);
    assert.match(permission, /^\s{2}task:\s*deny$/m);
    assert.match(permission, /^\s{2}lsp:\s*deny$/m);
    assert.match(permission, /^\s{2}bash:\s*$/m);
    assert.match(permission, /^\s{4}"\*":\s*deny$/m);
  });

  it("denies sensitive reads regardless of the add-on's file-access setting", () => {
    const permission = fields.permission?.__raw ?? "";
    for (const pattern of [
      '"\\*secrets.yaml": deny',
      '"\\*.storage/\\*": deny',
      '"\\*.cloud/\\*": deny',
      '"\\*ssl/\\*": deny',
      '"\\*.key": deny',
      '"\\*.pem": deny',
    ]) {
      assert.match(permission, new RegExp(pattern.replace(/ /g, "\\s*")));
    }
    assert.match(permission, /"\*":\s*allow/);
  });

  it("removes the mutating tools outright, not only by permission", () => {
    const tools = fields.tools?.__raw ?? "";
    for (const tool of ["bash", "edit", "write", "patch", "task"]) {
      assert.match(tools, new RegExp(`^\\s{2}${tool}:\\s*false$`, "m"), `${tool} is still enabled`);
    }
  });

  it("tells the session that the compact profile and native MCP are in force", () => {
    assert.match(body, /compact/);
    assert.match(body, /native MCP/i);
    assert.match(body, /home-assistant-troubleshooting/);
  });

  it("never claims it can change anything", () => {
    assert.ok(!/\bwrite_config_safe\(/.test(body));
    assert.match(block, /mode: primary/);
  });
});
