const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const addon = path.resolve(__dirname, "..");
const launcher = path.join(addon, "rootfs/etc/s6-overlay/s6-rc.d/ha-openchamber/run");
const source = fs.readFileSync(launcher, "utf8");
const option = "openchamber_allow_remote_speech";
const flag = "OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS";
const { parseDocument } = createRequire(path.join(addon, "rootfs/opt/ha-mcp-server/package.json"))("yaml");
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe") : "bash";
const shellPath = value => value.replaceAll("\\", "/").replace(/^([a-z]):/i, (_match, drive) => `/${drive.toLowerCase()}`);

test("remote speech has a default-off optional boolean and an explicit trust warning", () => {
  const load = file => {
    const doc = parseDocument(fs.readFileSync(path.join(addon, file), "utf8"), { uniqueKeys: true });
    assert.deepEqual(doc.errors, []);
    return doc.toJS();
  };
  const config = load("config.yaml");
  assert.equal(config.options[option], false);
  assert.equal(config.schema[option], "bool?");
  const label = load("translations/en.yaml").configuration[option];
  assert.match(label.name, /speech servers/i);
  assert.match(label.description, /any HTTP\(S\) speech destination/);
  assert.match(label.description, /restart/);
  const docs = fs.readFileSync(path.join(addon, "DOCS.md"), "utf8");
  assert.ok(docs.includes(option));
  assert.match(docs, /not\s+only Home Assistant apps or your LAN/);
});

test("speech opt-in preserves the managed launcher's credential and binding isolation", () => {
  assert.match(source, /bashio::config 'openchamber_allow_remote_speech' 'false'/);
  assert.ok(source.includes(`${flag}="false"`));
  assert.ok(source.includes(`${flag}="$${flag}"`));
  assert.match(source, /exec env -i/);
  assert.match(source, /OPENCHAMBER_HOST="127\.0\.0\.1"/);
  assert.match(source, /OPENCODE_HOST="http:\/\/127\.0\.0\.1:4100" OPENCODE_SKIP_START="true"/);
  assert.match(source, /LD_PRELOAD="\/usr\/local\/lib\/opencode-v2-non-dumpable\.so"/);
  assert.doesNotMatch(source, /SUPERVISOR_TOKEN|OPENCODE_SERVER_PASSWORD|source \/data\//);
});

test("real launcher passes only an explicit opt-in and ignores inherited speech/auth overrides", { skip: process.platform === "win32" && !fs.existsSync(bash) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-speech-launcher-"));
  try {
    // Use the real env with the launcher's assignments, but replace its command
    // with env itself. Record the image-only preload without loading it here.
    // No services or /data are touched.
    fs.writeFileSync(path.join(root, "env"), `#!/bin/bash
printf '%s\\n' "$1"
shift
assignments=()
while [[ "$1" == *=* ]]; do
  if [[ "$1" == LD_PRELOAD=* ]]; then printf '%s\\n' "$1"; else assignments+=("$1"); fi
  shift
done
/usr/bin/env -i "\${assignments[@]}" /usr/bin/env
`, { mode: 0o700 });
    const harness = `PATH="$2:/usr/bin:/bin"
cat() { printf openchamber; }
mkdir() { :; }
bashio::log.info() { :; }
bashio::config() {
  case "$1" in
    openchamber_allow_remote_speech) printf '%s' "\${SPEECH_TEST_OPTION:-$2}" ;;
    *) printf '%s' "$2" ;;
  esac
}
source "$1"`;
    for (const [value, expected] of [["", "false"], ["false", "false"], ["true", "true"], ["yes", "false"], ["$(touch must-not-execute)", "false"]]) {
      const result = spawnSync(bash, ["-c", harness, "speech-fixture", shellPath(launcher), shellPath(root)], {
        cwd: root, encoding: "utf8", env: {
          PATH: `${shellPath(root)}:/usr/bin:/bin`, SPEECH_TEST_OPTION: value,
          SUPERVISOR_TOKEN: "synthetic-supervisor-must-not-leak",
          OPENCODE_SERVER_PASSWORD: "synthetic-password-must-not-leak",
          OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS: "true",
          OPENCHAMBER_HOST: "0.0.0.0", NODE_OPTIONS: "--trace-warnings",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split(/\r?\n/);
      assert.equal(args[0], "-i");
      assert.equal(args.filter(arg => arg.startsWith(`${flag}=`)).length, 1);
      assert.ok(args.includes(`${flag}=${expected}`));
      assert.ok(args.includes("OPENCHAMBER_HOST=127.0.0.1"));
      assert.ok(args.includes("NODE_OPTIONS=--max-old-space-size=768"));
      assert.ok(args.includes("LD_PRELOAD=/usr/local/lib/opencode-v2-non-dumpable.so"));
      assert.doesNotMatch(result.stdout, /synthetic-supervisor|synthetic-password|SPEECH_TEST_OPTION|--trace-warnings/);
      assert.equal(fs.existsSync(path.join(root, "must-not-execute")), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
