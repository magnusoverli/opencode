// Fail closed on pinned-source drift; install before compiling either web surface.
const fs = require('node:fs');
const path = require('node:path');

function patchWorkspaceRecovery(root) {
  const edits = [
    ['packages/ui/src/main.tsx',
      '            <App apis={runtimeAPIs} />',
      '            <WorkspaceRecoveryGate><App apis={runtimeAPIs} /></WorkspaceRecoveryGate>'],
    ['packages/ui/src/apps/renderMobileApp.tsx',
      '  const app = <MobileApp apis={resolvedApis} />;',
      '  const app = isNativeShell ? <MobileApp apis={resolvedApis} /> : <WorkspaceRecoveryGate><MobileApp apis={resolvedApis} /></WorkspaceRecoveryGate>;'],
  ];
  const files = new Map();
  for (const [file, before, after] of edits) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    if (source.split(before).length !== 2 || source.includes('WorkspaceRecoveryGate')) {
      throw new Error(`Unexpected workspace recovery source: ${file}`);
    }
    files.set(file, "import { WorkspaceRecoveryGate } from '@/components/auth/WorkspaceRecoveryGate';\n" + source.replace(before, after));
  }
  for (const [name, target] of [
    ['WorkspaceRecoveryGate.tsx', 'packages/ui/src/components/auth/WorkspaceRecoveryGate.tsx'],
    ['workspaceRecovery.ts', 'packages/ui/src/lib/workspaceRecovery.ts'],
  ]) {
    if (fs.existsSync(path.join(root, target))) throw new Error(`Workspace recovery already exists: ${target}`);
    files.set(target, fs.readFileSync(path.join(__dirname, 'workspace-recovery', name), 'utf8'));
  }
  for (const [file, source] of files) fs.writeFileSync(path.join(root, file), source);
}
module.exports = { patchWorkspaceRecovery };
if (require.main === module) patchWorkspaceRecovery(process.argv[2]);
