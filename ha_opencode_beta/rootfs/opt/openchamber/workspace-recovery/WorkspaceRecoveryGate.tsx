import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { updateBrowserURL } from '@/lib/router/serializeRoute';
import { probeWorkspace, verifyRecoveryWorkspace, type WorkspaceRead } from '@/lib/workspaceRecovery';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const read: WorkspaceRead = (path, query, signal) => runtimeFetch(path, { query, signal });

// Keep normal navigation mounted while probing. Only a confirmed missing location
// blocks the application, so temporary backend/auth failures retain upstream retry UI.
export function WorkspaceRecoveryGate({ children }: { children: React.ReactNode }) {
  const workspaceDirectory = useDirectoryStore(state => state.currentDirectory);
  const sessionId = useSessionUIStore(state => state.currentSessionId);
  const sessionDirectory = useSessionUIStore(state => state.currentSessionDirectory);
  // Mobile/settings hydration can restore the project pointer independently of
  // the selected conversation. Check its real scope, not just the browsing path.
  const directory = sessionId && sessionDirectory ? sessionDirectory : workspaceDirectory;
  const home = useDirectoryStore(state => state.homeDirectory);
  const projects = useProjectsStore(state => state.projects);
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  const [check, setCheck] = React.useState<{ directory: string; runtime: string; missing: boolean } | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [target, setTarget] = React.useState('/homeassistant');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const result = await probeWorkspace(directory, read);
      if (!active || getRuntimeKey() !== runtime) return;
      setCheck(previous => ({ directory, runtime,
        missing: result === 'missing' || (result === 'unknown' && previous?.directory === directory &&
          previous.runtime === runtime && previous.missing),
      }));
      // An offline initial probe must not permanently miss a stale workspace.
      if (result === 'unknown') timer = setTimeout(() => void run(), 3000);
    };
    void run();
    return () => { active = false; clearTimeout(timer); };
  }, [directory, runtime, attempt]);

  const missing = check?.missing && check.directory === directory && check.runtime === runtime;
  const recover = async (candidate: string) => {
    const normalized = normalizePath(candidate);
    if (!normalized || busy) return;
    setBusy(true);
    setError('');
    const current = () => getRuntimeKey() === runtime &&
      useDirectoryStore.getState().currentDirectory === workspaceDirectory &&
      useSessionUIStore.getState().currentSessionId === sessionId &&
      useSessionUIStore.getState().currentSessionDirectory === sessionDirectory;
    try {
      const scopedRead: WorkspaceRead = (path, query, signal) => current()
        ? read(path, query, signal) : Promise.reject(new Error('Workspace selection changed'));
      if (!await verifyRecoveryWorkspace(normalized, scopedRead)) {
        if (current()) setError('This directory could not be verified. Check the path, permissions and server connection.');
        return;
      }
      if (!current()) return;
      const project = await useProjectsStore.getState().addProject(normalized);
      // addProject itself selects the project and updates currentDirectory.
      if (getRuntimeKey() !== runtime || ![workspaceDirectory, normalized].includes(useDirectoryStore.getState().currentDirectory) ||
        useSessionUIStore.getState().currentSessionId !== sessionId) return;
      if (!project) { setError('Could not select this workspace. Try another existing directory.'); return; }
      useProjectsStore.getState().setActiveProject(project.id);
      // User navigation clears only the last-open pointer, never session history
      // or its recorded directory. No session move, filesystem create or delete.
      useSessionUIStore.getState().openNewSessionDraft({
        target: 'project', selectedProjectId: project.id, directoryOverride: normalized,
      });
      // App's router is unmounted while recovery is displayed. Clear its stale
      // session/message route explicitly, or remount will reopen the old session.
      const ui = useUIStore.getState();
      updateBrowserURL({ sessionId: null, isSettingsOpen: ui.isSettingsDialogOpen,
        settingsPath: ui.settingsPage }, { replace: true, force: true });
      useDirectoryStore.getState().setDirectory(normalized, { showOverlay: false });
    } catch {
      if (current()) setError('Workspace selection failed. Your conversations have not been moved or deleted.');
    } finally { setBusy(false); }
  };

  if (!check || check.runtime !== runtime) return <div role="status" className="p-6">Checking workspace…</div>;
  // Project registration selects its directory before the awaited call returns;
  // don't remount the application until the old last-open session is cleared.
  if (!missing && !busy) return <>{children}</>;
  const candidates = [...new Set(['/homeassistant', ...projects.map(project => project.path), home].filter(Boolean))]
    .filter(path => path !== directory);
  return <main data-testid="workspace-recovery" className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">Workspace unavailable</h1>
    <p>The selected workspace no longer exists or is not a directory:</p>
    <pre className="whitespace-pre-wrap break-all">{directory}</pre>
    <p>Your conversation history is preserved. Open an existing workspace to continue with a new draft. Historical conversations keep their original directory.</p>
    <div className="flex flex-wrap gap-2">
      {candidates.map(path => <button key={path} type="button" disabled={busy} className="rounded border p-2 break-all"
        onClick={() => void recover(path)}>Open {path}</button>)}
    </div>
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void recover(target); }}>
      <label className="block" htmlFor="recovery-directory">Existing workspace directory</label>
      <input id="recovery-directory" className="w-full rounded border bg-transparent p-2" value={target}
        onChange={event => setTarget(event.target.value)} disabled={busy} />
      <button type="submit" className="rounded border p-2" disabled={busy}>Open workspace</button>
    </form>
    <button type="button" className="rounded border p-2" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Check again</button>
    {error && <p role="alert">{error}</p>}
  </main>;
}
