import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.OPENCHAMBER_TEST_SOURCE || "/opt/openchamber-preview";
const web = createRequire(join(source, "packages/web/package.json"));
const proxy = createRequire(web.resolve("http-proxy-middleware"));
const match = createRequire(proxy.resolve("micromatch"));
const braces = match("braces");
test("braces rejects deep patterns and caller-supplied ASTs without stack overflow", () => {
  for (const pattern of ["{".repeat(4000) + "a,b" + "}".repeat(4000), "(".repeat(4000) + "x" + ")".repeat(4000)]) {
    for (const operation of [braces.parse, braces.compile, braces.expand]) {
      assert.throws(() => operation(pattern), { name: "SyntaxError", message: /nesting.*64/ });
    }
  }
  let ast = { type: "text", value: "x" };
  for (let depth = 0; depth < 2000; depth++) ast = { type: "root", nodes: [ast] };
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(ast), { name: "SyntaxError", message: /nesting.*64/ });
  }
  assert.deepEqual(braces.expand("src/{a,{b,c}}.{js,ts}"), ["src/a.js", "src/a.ts", "src/b.js", "src/b.ts", "src/c.js", "src/c.ts"]);
  assert.deepEqual(braces.expand("item{1..3}"), ["item1", "item2", "item3"]);
  assert.deepEqual(proxy("micromatch")(["/api/x", "/auth/x", "/assets/x"], ["/{api,auth}/**"]), ["/api/x", "/auth/x"]);
});

test("updated Git runtime preserves local repository operations and rejects unsafe configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-git-security-"));
  const { simpleGit } = await import(pathToFileURL(join(dirname(web.resolve("simple-git")), "index.mjs")));
  try {
    const git = simpleGit(root);
    await git.init();
    await git.addConfig("user.name", "HA fixture");
    await git.addConfig("user.email", "fixture@example.invalid");
    await writeFile(join(root, "file with spaces.txt"), "first\n");
    await git.add(["file with spaces.txt"]);
    await git.commit("fixture initial");
    assert.equal((await git.log()).latest.message, "fixture initial");
    assert.equal((await git.status()).isClean(), true);
    // Exercise the actual service's new read-only GIT_OPTIONAL_LOCKS control,
    // not just the dependency factory (which would miss a stale allowlist).
    const { getStatus } = await import(pathToFileURL(join(source, "packages/web/server/lib/git/service.js")));
    assert.equal((await getStatus(root)).isClean, true);
    await writeFile(join(root, "file with spaces.txt"), "second\n");
    assert.match(await git.diff(), /\+second/);
    await git.checkout(["--", "file with spaces.txt"]);
    await git.checkoutLocalBranch("fixture-branch");
    assert.equal((await git.branchLocal()).current, "fixture-branch");
    const worktree = join(root, "worktree with spaces");
    await git.raw(["worktree", "add", "--detach", worktree, "HEAD"]);
    assert.equal((await simpleGit(worktree).status()).isClean(), true);
    await git.raw(["worktree", "remove", worktree]);
    const guarded = simpleGit({ baseDir: root, allowEnvironment: ["GIT_TERMINAL_PROMPT"] });
    guarded.env(Object.assign(Object.create({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false" }), { PATH: process.env.PATH }));
    assert.equal((await guarded.status()).isClean(), true);
    await assert.rejects(guarded.raw(["-c", "trailer.audit.cmd=echo should-not-run", "status"]), /unsafe|not permitted|blocked|not allowed/i);
    await assert.rejects(simpleGit(root).env({ PATH: process.env.PATH, GIT_SSH_COMMAND: "echo should-not-run" }).status(), /unsafe|not permitted|blocked|not allowed/i);
    await assert.rejects(simpleGit({ baseDir: root, config: ["trailer.audit.cmd=echo should-not-run"] }).raw(["status"]), /unsafe|not permitted|blocked/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
