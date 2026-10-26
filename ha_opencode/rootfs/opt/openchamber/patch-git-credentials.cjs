// Preserve explicit system/global Git config isolation when delegating outside
// a repository. Also isolate upstream's enterprise-account test from a real gh.
const fs = require('node:fs');
const path = require('node:path');

function patchGitCredentials(root) {
  const changes = new Map();
  const stage = (file, before, after) => {
    const target = path.join(root, file);
    const source = changes.get(target) ?? fs.readFileSync(target, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`Unexpected pinned Git credential source: ${file}`);
    changes.set(target, source.replace(before, after));
  };
  stage('packages/web/server/lib/git/repository-credential-helper.js',
    "    if (name.startsWith('GIT_CONFIG_') || name === 'GIT_DIR' || name === 'GIT_WORK_TREE') delete env[name];",
    "    const globalConfigControl = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'].includes(name);\n    if ((name.startsWith('GIT_CONFIG_') && !globalConfigControl) || name === 'GIT_DIR' || name === 'GIT_WORK_TREE') delete env[name];");
  const test = 'packages/web/server/lib/github/octokit.test.js';
  stage(test,
    "      const resolved = await getOctokitForAccountId('github.example.com#cli:42');",
    "      // Use the fixture's fake CLI, never the developer's or builder's gh.\n      process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;\n      const resolved = await getOctokitForAccountId('github.example.com#cli:42').finally(() => {\n        if (previousPath === undefined) delete process.env.PATH;\n        else process.env.PATH = previousPath;\n      });");
  for (const [target, source] of changes) fs.writeFileSync(target, source);
}

module.exports = { patchGitCredentials };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: patch-git-credentials.cjs <pinned-repository-root>');
  patchGitCredentials(process.argv[2]);
}
