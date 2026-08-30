import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ADDON_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = join(ADDON_ROOT, "rootfs", "opt", "opencode-v2-homeassistant");
const CLI = join(PACKAGE_ROOT, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe");
const SENTINEL = "supervisor-token-must-not-appear";

describe("real OpenCode V2 readiness probe", () => {
  it("confines version-probe writes to scrubbed disposable roots", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "opencode-v2-version-probe-"));
    try {
      const v1 = join(sandbox, "v1");
      const probe = join(sandbox, "v2", "work", ".runtime-probe.test");
      const v1Roots = {
        home: join(v1, "home"),
        config: join(v1, "config"),
        data: join(v1, "data"),
        state: join(v1, "state"),
        cache: join(v1, "cache"),
      };
      const probeRoots = {
        home: join(probe, "home"),
        config: join(probe, "config"),
        data: join(probe, "data"),
        state: join(probe, "state"),
        cache: join(probe, "cache"),
      };
      const workspace = join(probe, "workspace");
      const temporary = join(probe, "tmp");
      await Promise.all([
        ...Object.values(v1Roots).map((path) => mkdir(path, { recursive: true })),
        ...Object.values(probeRoots).map((path) => mkdir(path, { recursive: true })),
        mkdir(workspace, { recursive: true }),
        mkdir(temporary, { recursive: true }),
      ]);
      await Promise.all(Object.entries(v1Roots).map(([name, path]) => (
        writeFile(join(path, `${name}.sentinel`), `${name}-unchanged`)
      )));
      const inherited = {
        ...process.env,
        HOME: v1Roots.home,
        XDG_CONFIG_HOME: v1Roots.config,
        XDG_DATA_HOME: v1Roots.data,
        XDG_STATE_HOME: v1Roots.state,
        XDG_CACHE_HOME: v1Roots.cache,
        SUPERVISOR_TOKEN: SENTINEL,
      };
      const env = {
        HOME: probeRoots.home,
        USERPROFILE: probeRoots.home,
        XDG_CONFIG_HOME: probeRoots.config,
        XDG_DATA_HOME: probeRoots.data,
        XDG_STATE_HOME: probeRoots.state,
        XDG_CACHE_HOME: probeRoots.cache,
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        PATH: inherited.PATH,
        LANG: "C.UTF-8",
        USER: "opencode-v2",
        LOGNAME: "opencode-v2",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      };
      for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
        if (inherited[name]) env[name] = inherited[name];
      }

      const result = spawnSync(CLI, ["--version"], {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout.trim(), /(?:^|\sv?)0\.0\.0-beta-18684$/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SENTINEL));
      for (const [name, path] of Object.entries(v1Roots)) {
        assert.deepEqual(await readdir(path), [`${name}.sentinel`]);
        assert.equal(await readFile(join(path, `${name}.sentinel`), "utf8"), `${name}-unchanged`);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
