// #226: offer HA's non-Git migration workspace in the existing project picker.
// The upstream picker still verifies availability and owns registration.
const fs = require("node:fs");
const path = require("node:path");

function patchManagedHistory(root) {
  const dir = path.join(root, "packages/ui/src/components/session/project-import");
  const changes = new Map();
  function edit(file, before, after) {
    const target = path.join(dir, file);
    const source = changes.get(target) ?? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    if (source.split(before).length !== 2 || source.includes(after)) {
      throw new Error(`Unexpected OpenChamber managed-history source: ${file}`);
    }
    changes.set(target, source.replace(before, after));
  }
  const candidates = "openCodeProjectCandidates.ts";
  edit(candidates, "const TEMPORARY_ROOT =", `export const HA_HISTORY_WORKSPACE = '/run/opencode-v2/workspace';

export function hasManagedSessionHistory(sessions: readonly { directory?: string | null; parentID?: string | null }[] | null): boolean {
  return sessions?.some(s => !s.parentID && normalizePath(s.directory) === HA_HISTORY_WORKSPACE) ?? false;
}

const TEMPORARY_ROOT =`);
  edit(candidates, "  configuredPaths: ReadonlySet<string>,", "  configuredPaths: ReadonlySet<string>,\n  hasManagedHistory = false,");
  edit(candidates, "  for (const project of [...projects]", `  if (hasManagedHistory && !configuredPaths.has(HA_HISTORY_WORKSPACE)) {
    candidates.push({ path: HA_HISTORY_WORKSPACE, parent: '/run/opencode-v2', name: 'Home Assistant conversation history' });
    seen.add(HA_HISTORY_WORKSPACE);
  }
  for (const project of [...projects]`);
  const hook = "useOpenCodeProjects.ts";
  edit(hook, "import { openCodeProjectCandidates,", `import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { hasManagedSessionHistory, openCodeProjectCandidates,`);
  edit(hook, "  const hasServerSnapshot =", `  const sessions = useGlobalSessionsStore(state => enabled ? state.authoritativeSessions : null);
  const hasManagedHistory = React.useMemo(() => hasManagedSessionHistory(sessions), [sessions]);
  const hasServerSnapshot =`);
  edit(hook, "openCodeProjectCandidates(projects, configured)", "openCodeProjectCandidates(projects, configured, hasManagedHistory)");
  edit(hook, "[enabled, hasServerSnapshot, runtimeKey]", "[enabled, hasServerSnapshot, runtimeKey, hasManagedHistory]");
  for (const [target, source] of changes) fs.writeFileSync(target, source);
}

module.exports = { patchManagedHistory };
if (require.main === module) patchManagedHistory(process.argv[2]);
