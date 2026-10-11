import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const underData of [false, true]) {
test(`failed configuration staging explains recovery (temporary data path: ${underData})`, { skip: process.platform !== "linux" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "ha-startup-error-"));
  const root = underData ? join(parent, "data", "fixture") : parent;
  try {
    await mkdir(root, { recursive: true });
    const init = await readFile(new URL("../rootfs/etc/s6-overlay/s6-rc.d/init-opencode/run", import.meta.url), "utf8");
    const guard = init.match(/if (\{ node \/opt\/opencode-v2-homeassistant\/managed-config\.js[\s\S]*?; \}) \\\n\s*&& node/);
    assert.ok(guard, "exercise the actual configuration staging guard");
    const runGuard = (status) => spawnSync("bash", ["-c", `node() { return ${status}; }; if ${guard[1]}; then echo ready; else echo failed; fi`], {
      encoding: "utf8", env: { PATH: process.env.PATH, V2_RUNTIME_ROOT: root, V2_CONFIG_TEMP: join(root, "managed") },
    });
    assert.equal(runGuard(0).stdout.trim(), "ready");
    await assert.rejects(stat(join(root, "configuration-error")), { code: "ENOENT" });
    assert.equal(runGuard(1).stdout.trim(), "failed");
    assert.equal((await readFile(join(root, "configuration-error"))).length, 0);

    const source = await readFile(new URL("../rootfs/usr/local/bin/opencode-v2-session", import.meta.url), "utf8");
    const paths = { "/run/opencode-v2": root, "/data/": `${root}/data/`, "/usr/local/share/": `${root}/share/` };
    const session = source
      .replace("source /usr/local/lib/opencode/channel.sh", "ADDON_CHANNEL_LABEL=Fixture")
      // Match original text only: a temp directory under /data must not be rewritten twice.
      .replace(/\/run\/opencode-v2|\/data\/|\/usr\/local\/share\//g, (path) => paths[path])
      .replace("exec sleep infinity", "exit 0");
    const script = join(root, "session.sh");
    await writeFile(script, `clear() { :; }; jq() { return 1; };\n${session}`);
    const shown = spawnSync("bash", [script], { encoding: "utf8", timeout: 5000 });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /custom configuration could not be prepared/);
    assert.match(shown.stdout, /opencode_config.*external_mcp_config/);
    assert.match(shown.stdout, /Correct the corresponding option.*restart/);
    assert.match(shown.stdout, /reinstalling is not required/);
    await rm(join(root, "configuration-error"));
    const fallback = spawnSync("bash", [script], { encoding: "utf8", timeout: 5000 });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /V2 server is not ready/);
    assert.doesNotMatch(fallback.stdout, /custom configuration could not be prepared/);
    const unexpectedWork = session.replace(/jq -e '.error == "unexpected_migration_work"'[^;]+;/, "true;");
    await writeFile(script, `clear() { :; }; jq() { return 1; };\n${unexpectedWork}`);
    const diagnostic = spawnSync("bash", [script], { encoding: "utf8", timeout: 5000 });
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    assert.match(diagnostic.stdout, /unrecognized migration work needs attention/);
    assert.match(diagnostic.stdout, /do not delete unknown work entries/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
}
