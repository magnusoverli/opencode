// Static graph regression coverage for issue #95. The devcontainer acceptance
// harness separately exercises these definitions under real s6 and Supervisor.

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
    it(`${channel} independently supervises the shared router and UI backends`, () => {
      const server = read(servicePath(channel, "ha-openchamber", "run"));
      const ingress = read(servicePath(channel, "ha-openchamber-ingress", "run"));
      const terminal = read(servicePath(channel, "ha-opencode", "run"));
      const dockerfile = read(path.join(REPOSITORY_ROOT, channel, "Dockerfile"));

      assert.equal(read(servicePath(channel, "ha-openchamber-ingress", "type")), "longrun\n");
      assert.equal(
        fs.existsSync(servicePath(channel, "user", "contents.d", "ha-openchamber-ingress")),
        true,
      );
      assert.deepEqual(
        fs.readdirSync(servicePath(channel, "ha-openchamber-ingress", "dependencies.d")),
        ["init-opencode"],
        "shared ingress must start after init, independently of either UI or MCP backend",
      );
      assert.equal(
        fs.existsSync(servicePath(channel, "ha-openchamber-lan", "dependencies.d", "ha-openchamber")),
        true,
      );

      assert.match(server, /^exec "\$\{OPENCHAMBER_BIN\}" serve/m);
      assert.doesNotMatch(server, /OPENCHAMBER_PID|wait -n|trap cleanup/);
      assert.doesNotMatch(server, /^.*\s&\s*(?:#.*)?$/m);

      assert.match(ingress, /^exec env -i PATH="\/usr\/local\/bin:\/usr\/bin:\/bin"/m);
      assert.match(ingress, /OPENCHAMBER_UPSTREAM_PORT="\$\{OPENCHAMBER_UPSTREAM_PORT\}" \\\n\s+node \/usr\/local\/bin\/openchamber-ingress-proxy\.js\s*$/);
      assert.doesNotMatch(ingress, /^.*\s&\s*(?:#.*)?$/m);
      assert.doesNotMatch(ingress, /sleep|curl|s6-svc|source \/data/);
      assert.match(ingress, /^export OPENCHAMBER_INGRESS_HOST="0\.0\.0\.0"$/m);
      assert.match(ingress, /^export OPENCHAMBER_INGRESS_PORT=8099$/m);
      assert.match(ingress, /^export OPENCHAMBER_UPSTREAM_HOST="127\.0\.0\.1"$/m);
      assert.match(ingress, /^export OPENCHAMBER_UPSTREAM_PORT=3010$/m);
      assert.match(ingress, /if \[ "\$\{HA_INGRESS_UI\}" != "openchamber" \]; then\s+export HA_INGRESS_UI="terminal"\s+export OPENCHAMBER_UPSTREAM_PORT=8100\s+fi/);
      assert.match(ingress, /export OPENCHAMBER_ALLOW_ANY_REMOTE="false"/);
      assert.match(ingress, /export HA_INGRESS_PROXY_IP="172\.30\.32\.2"/);
      assert.match(terminal, /^exec ttyd \\/m);
      assert.match(terminal, /-i lo \\\n\s+-p 8100 \\/);
      assert.doesNotMatch(terminal, /-p 8099\b/);
      assert.match(
        dockerfile,
        /chmod \+x \/etc\/s6-overlay\/s6-rc\.d\/ha-openchamber-ingress\/run/,
      );
    });
  }
});
