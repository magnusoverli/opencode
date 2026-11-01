import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const patcher = new URL('../rootfs/opt/openchamber/patch-security-dependencies.cjs', import.meta.url);
const gitTest = 'packages/web/server/lib/git/service.test.js';
const oauthTest = 'packages/web/server/lib/github/octokit.test.js';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ha-security-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'openchamber-monorepo', version: '2.5.3', overrides: {} }),
    'packages/web/server/lib/git/service.js': [
      "import { simpleGit } from 'simple-git';", 'const simpleGitEnvOptions = (env) => {',
      'return { allowEnvironment: Object.keys(env), unsafe };', '!isKeptOutOfGitOverlay(name)',
      "env.GIT_OPTIONAL_LOCKS = '0';", '}).env(env);',
    ].join('\n'),
    [oauthTest]: [
      "  test('resolves a trusted enterprise host cli account id to a host-pinned octokit only after the instance is activated', async () => {",
      '    const previousFetch = globalThis.fetch;',
      '    try { expect(resolved).not.toBeNull(); } finally {',
      '      globalThis.fetch = previousFetch;', '    }', '  });', "  test('next', () => {});",
    ].join('\n'),
    [gitTest]: [
      '    addOptionLikeRemote(repository, remote);',
      "    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();",
      "    expect(branches.defaultBranches[OPTION_LIKE_REMOTE]).toBe('react');",
    ].join('\n'),
  };
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), source);
  }
  return { root, files };
}
const run = (root) => spawnSync(process.execPath, [patcher.pathname, root], { encoding: 'utf8' });

test('security source patch establishes Git fixture preconditions without removing assertions', async (t) => {
  const { root, files } = await fixture(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const git = await readFile(join(root, gitTest), 'utf8');
  assert.ok(git.includes("['symbolic-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/HEAD`, `refs/remotes/${OPTION_LIKE_REMOTE}/react`]"));
  assert.ok(git.includes("expect(branches.defaultBranches[OPTION_LIKE_REMOTE]).toBe('react')"));
  const oauth = await readFile(join(root, oauthTest), 'utf8');
  assert.ok(oauth.includes('process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;'));
  assert.ok(oauth.includes('else process.env.PATH = previousPath;'));
  assert.ok(oauth.includes('expect(resolved).not.toBeNull()'));
  assert.equal(await readFile(join(root, 'packages/web/server/lib/git/service.js'), 'utf8'), files['packages/web/server/lib/git/service.js']);
});

for (const drifted of [gitTest, oauthTest]) {
  test(`security source patch rejects drift before writes: ${drifted}`, async (t) => {
    const { root, files } = await fixture(t);
    files[drifted] = 'unreviewed upstream fixture';
    await writeFile(join(root, drifted), files[drifted]);
    assert.notEqual(run(root).status, 0);
    for (const [name, source] of Object.entries(files)) {
      assert.equal(await readFile(join(root, name), 'utf8'), source, name);
    }
  });
}
