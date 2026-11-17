const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { patchGitCredentials } = require('../rootfs/opt/openchamber/patch-git-credentials.cjs');

const helper = 'packages/web/server/lib/git/repository-credential-helper.js';
const enterprise = 'packages/web/server/lib/github/octokit.test.js';
const originalHelper = "    if (name.startsWith('GIT_CONFIG_') || name === 'GIT_DIR' || name === 'GIT_WORK_TREE') delete env[name];";
const originalTest = "      const resolved = await getOctokitForAccountId('github.example.com#cli:42');\n      expect(resolved.source).toBe('cli');";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-git-credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of [[helper, originalHelper], [enterprise, originalTest]]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

test('delegation preserves explicit config isolation but drops repository and command overrides', t => {
  const root = fixture(t);
  patchGitCredentials(root);
  const source = fs.readFileSync(path.join(root, helper), 'utf8');
  const filter = new Function('env', `for (const name of Object.keys(env)) { ${source} } return env;`);
  const env = { HOME: '/fixture/home', PATH: '/fixture/bin', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/fixture/system',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'untrusted',
    GIT_CONFIG_PARAMETERS: 'untrusted', GIT_DIR: '/repository/.git', GIT_WORK_TREE: '/repository' };
  assert.deepEqual(filter(env), { HOME: '/fixture/home', PATH: '/fixture/bin',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/fixture/system' });
  const patchedTest = fs.readFileSync(path.join(root, enterprise), 'utf8');
  assert.ok(patchedTest.indexOf('process.env.PATH =') < patchedTest.indexOf('await getOctokitForAccountId'));
  assert.match(patchedTest, /else process.env.PATH = previousPath/);
  assert.throws(() => patchGitCredentials(root), /Unexpected pinned/);
});

test('source drift in the test fixture fails before changing the credential helper', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, enterprise), originalTest.replace('getOctokitForAccountId', 'changedAccountLookup'));
  assert.throws(() => patchGitCredentials(root), /Unexpected pinned/);
  assert.equal(fs.readFileSync(path.join(root, helper), 'utf8'), originalHelper);
});
