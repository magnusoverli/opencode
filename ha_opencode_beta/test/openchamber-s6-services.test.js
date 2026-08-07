// Regression coverage for issue #95. These are s6-rc definitions, so inspect
// the shipped service graph rather than attempting to emulate s6 on the host.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const REPOSITORY_ROOT = path.join(__dirname, "..", "..");
const CHANNELS = ["ha_opencode", "ha_opencode_beta"];

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function servicePath(channel, ...parts) {
  return path.join(
    REPOSITORY_ROOT,
    channel,
    "rootfs",
    "etc",
    "s6-overlay",
    "s6-rc.d",
    ...parts,
  );
}

describe("OpenChamber s6 service ownership", () => {
  for (const channel of CHANNELS) {
    it(`${channel} directly supervises both listeners`, () => {
      const server = read(servicePath(channel, "ha-openchamber", "run"));
      const ingress = read(servicePath(channel, "ha-openchamber-ingress", "run"));
      const dockerfile = read(path.join(REPOSITORY_ROOT, channel, "Dockerfile"));

      assert.equal(read(servicePath(channel, "ha-openchamber-ingress", "type")), "longrun\n");
      assert.equal(
        fs.existsSync(servicePath(channel, "user", "contents.d", "ha-openchamber-ingress")),
        true,
      );
      assert.equal(
        fs.existsSync(servicePath(channel, "ha-openchamber-ingress", "dependencies.d", "ha-openchamber")),
        true,
      );
      assert.equal(
        fs.existsSync(servicePath(channel, "ha-openchamber-lan", "dependencies.d", "ha-openchamber")),
        true,
      );

      assert.match(server, /^exec "\$\{OPENCHAMBER_BIN\}" serve/m);
      assert.doesNotMatch(server, /OPENCHAMBER_PID|wait -n|trap cleanup/);
      assert.doesNotMatch(server, /^.*\s&\s*(?:#.*)?$/m);

      assert.match(ingress, /exec node \/usr\/local\/bin\/openchamber-ingress-proxy\.js/);
      assert.doesNotMatch(ingress, /^.*\s&\s*(?:#.*)?$/m);
      assert.match(ingress, /http:\/\/127\.0\.0\.1:\$\{OPENCHAMBER_INTERNAL_PORT\}\/health/);
      assert.match(ingress, /\/command\/s6-svc -r \/run\/service\/ha-openchamber/);
      assert.match(ingress, /export OPENCHAMBER_ALLOW_ANY_REMOTE="false"/);
      assert.match(
        dockerfile,
        /chmod \+x \/etc\/s6-overlay\/s6-rc\.d\/ha-openchamber-ingress\/run/,
      );
    });
  }
});
