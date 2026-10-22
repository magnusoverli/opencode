// Isolated hook harness against the actual patched, pinned component (Bun).
import { afterEach, expect, mock, test } from 'bun:test';

type Node = { type: string; props: Record<string, any> };
let values: any[] = [];
let effects: Array<{ deps: any[]; cleanup?: () => void }> = [];
let pending: Array<() => void> = [];
let index = 0;
let runtime = 'local';
let listener: (() => void) | undefined;
let response: (path: string) => Promise<Response>;
let drafts: any[] = [];
let registrations = 0;
let routes: any[] = [];
let settingsWrites: any[] = [];
let saveSettings: (changes: any) => Promise<{ ok: boolean }>;
const directory = { currentDirectory: '/missing', homeDirectory: '/homeassistant', setDirectory: (path: string) => { directory.currentDirectory = path; } };
const projects = {
  projects: [{ id: 'ha', path: '/homeassistant' }],
  addProject: async (path: string) => { registrations++; directory.currentDirectory = path; return { id: 'ha', path }; },
  setActiveProject: () => {},
};
const sessions = { currentSessionId: null as string | null, currentSessionDirectory: null as string | null,
  openNewSessionDraft: (options: any) => { drafts.push(options); sessions.currentSessionId = null; sessions.currentSessionDirectory = null; } };
const store = (state: any) => Object.assign((select: (state: any) => any) => select(state), { getState: () => state });
const React = {
  useState: (initial: any) => {
    const position = index++;
    if (!(position in values)) values[position] = typeof initial === 'function' ? initial() : initial;
    return [values[position], (value: any) => { values[position] = typeof value === 'function' ? value(values[position]) : value; }];
  },
  useEffect: (effect: () => void | (() => void), deps: any[]) => {
    const position = index++;
    const previous = effects[position];
    if (previous && deps.every((value, i) => value === previous.deps[i])) return;
    pending.push(() => {
      previous?.cleanup?.();
      effects[position] = { deps, cleanup: effect() || undefined };
    });
  },
};
mock.module('react', () => ({ default: React, ...React }));
mock.module('react/jsx-runtime', () => ({ jsx: (type: string, props: any) => ({ type, props }), jsxs: (type: string, props: any) => ({ type, props }), Fragment: 'fragment' }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: (path: string) => response(path) }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtime, subscribeRuntimeEndpointChanged: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; } }));
mock.module('@/lib/pathNormalization', () => ({ normalizePath: (path: string) => path.trim() || null }));
mock.module('@/lib/router/serializeRoute', () => ({ updateBrowserURL: (...args: any[]) => { routes.push(args); } }));
mock.module('@/lib/persistence', () => ({ updateDesktopSettings: (changes: any) => { settingsWrites.push(changes); return saveSettings(changes); } }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: store(directory) }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: store(projects) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: store({ isSettingsDialogOpen: false, settingsPage: 'settings' }) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: store(sessions) }));
const { WorkspaceRecoveryGate } = await import('@/components/auth/WorkspaceRecoveryGate');

const render = () => {
  index = 0;
  const tree = WorkspaceRecoveryGate({ children: 'APP' }) as Node;
  for (const effect of pending.splice(0)) effect();
  return tree;
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const nodes = (tree: any): Node[] => {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
};
const choose = (tree: Node) => nodes(tree).find(node => node.type === 'button' && node.props.children?.[1] === '/homeassistant')!.props.onClick();
function reset() {
  values = []; effects = []; pending = []; drafts = []; registrations = 0; routes = []; settingsWrites = [];
  saveSettings = async () => ({ ok: true });
  runtime = 'local'; directory.currentDirectory = '/missing';
  sessions.currentSessionId = null; sessions.currentSessionDirectory = null;
  response = async path => path === '/api/location' ? Response.json({ directory: '/homeassistant' }) :
    directory.currentDirectory === '/missing' ? Response.json({ reason: 'not-found' }, { status: 404 }) : Response.json({ isDirectory: true });
}
afterEach(() => { for (const effect of effects) effect?.cleanup?.(); });

test('confirmed missing selection blocks app; unknown transport failure does not', async () => {
  reset(); render();
  expect((await settle()).props['data-testid']).toBe('workspace-recovery');
  expect(registrations).toBe(0);
  expect(drafts).toEqual([]);
  reset(); response = async () => { throw new Error('offline'); }; render();
  expect((await settle()).props.children).toBe('APP');
  expect(directory.currentDirectory).toBe('/missing');
});

test('a valid browsing project does not hide a missing selected session workspace', async () => {
  reset(); directory.currentDirectory = '/homeassistant';
  sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  response = async () => Response.json({ reason: 'not-found' }, { status: 404 });
  render(); const tree = await settle();
  expect(tree.props['data-testid']).toBe('workspace-recovery');
  expect(nodes(tree).some(node => node.type === 'pre' && node.props.children === '/missing')).toBe(true);
  expect(sessions.currentSessionId).toBe('historical');
  expect(registrations).toBe(0); expect(drafts).toEqual([]);
});

test('recovery clears only current selection after addProject has switched directory', async () => {
  reset(); render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  choose(tree); await settle();
  expect(registrations).toBe(1);
  expect(drafts).toEqual([{ target: 'project', selectedProjectId: 'ha', directoryOverride: '/homeassistant' }]);
  expect(routes).toEqual([[{ sessionId: null, isSettingsOpen: false, settingsPath: 'settings' }, { replace: true, force: true }]]);
  expect(directory.currentDirectory).toBe('/homeassistant');
});

test('recovery waits for durable project selection before clearing the historical pointer or resuming the app', async () => {
  reset(); sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  let release!: (result: { ok: boolean }) => void;
  saveSettings = () => new Promise(resolve => { release = resolve; });
  choose(tree); const saving = await settle();
  expect(settingsWrites).toEqual([{ projects: projects.projects, activeProjectId: 'ha', lastDirectory: '/homeassistant' }]);
  expect(saving.props['data-testid']).toBe('workspace-recovery');
  expect(sessions.currentSessionId).toBe('historical');
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
  release({ ok: true }); const resumed = await settle();
  expect(resumed.props.children).toBe('APP');
  expect(drafts).toHaveLength(1);
  expect(sessions.currentSessionId).toBe(null);
});

test('a failed settings save keeps recovery visible and preserves the historical navigation pointer', async () => {
  reset(); render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  saveSettings = async () => ({ ok: false });
  choose(tree); let failed = await settle();
  expect(failed.props['data-testid']).toBe('workspace-recovery');
  expect(nodes(failed).some(node => node.props.role === 'alert')).toBe(true);
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
  saveSettings = async () => ({ ok: true });
  const form = nodes(failed).find(node => node.type === 'form')!;
  form.props.onSubmit({ preventDefault() {} });
  failed = await settle();
  expect(failed.props.children).toBe('APP');
  expect(drafts).toHaveLength(1);
});

test('a settings save from a previous runtime cannot finish recovery on another host', async () => {
  reset(); render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  let release!: (result: { ok: boolean }) => void;
  saveSettings = () => new Promise(resolve => { release = resolve; });
  choose(tree); await settle();
  runtime = 'other'; directory.currentDirectory = '/other-host'; listener?.();
  release({ ok: true }); await settle();
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
  expect(directory.currentDirectory).toBe('/other-host');
});

test('a rejected settings save cannot expose an unsaved draft', async () => {
  reset(); sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  saveSettings = async () => { throw new Error('offline'); };
  choose(tree); const failed = await settle();
  expect(failed.props['data-testid']).toBe('workspace-recovery');
  expect(nodes(failed).some(node => node.props.role === 'alert')).toBe(true);
  expect(sessions.currentSessionId).toBe('historical');
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
});

test('browsing hydration cannot cancel recovery for the unchanged historical conversation', async () => {
  reset(); sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  render(); const tree = await settle();
  let releaseProbe!: (response: Response) => void;
  response = path => path === '/api/location' ? Promise.resolve(Response.json({ directory: '/homeassistant' })) :
    new Promise(resolve => { releaseProbe = resolve; });
  choose(tree);
  directory.currentDirectory = '/hydrated-browsing';
  releaseProbe(Response.json({ isDirectory: true }));
  await settle();
  expect(drafts).toHaveLength(1);
  expect(directory.currentDirectory).toBe('/homeassistant');
});

test('browsing hydration cannot hide a failed recovery save for the unchanged conversation', async () => {
  reset(); sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  render(); const tree = await settle();
  response = async path => Response.json(path === '/api/location' ? { directory: '/homeassistant' } : { isDirectory: true });
  let release!: (result: { ok: boolean }) => void;
  saveSettings = () => new Promise(resolve => { release = resolve; });
  choose(tree); await settle();
  directory.currentDirectory = '/hydrated-browsing';
  release({ ok: false }); const failed = await settle();
  expect(failed.props['data-testid']).toBe('workspace-recovery');
  expect(nodes(failed).some(node => node.props.role === 'alert')).toBe(true);
  expect(sessions.currentSessionId).toBe('historical');
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
});

test('a genuinely different conversation still cancels a pending recovery', async () => {
  reset(); sessions.currentSessionId = 'historical'; sessions.currentSessionDirectory = '/missing';
  render(); const tree = await settle();
  let release!: (response: Response) => void;
  response = () => new Promise(resolve => { release = resolve; });
  choose(tree);
  sessions.currentSessionId = 'newer-selection';
  release(Response.json({ isDirectory: true })); await settle();
  expect(registrations).toBe(0);
  expect(drafts).toEqual([]); expect(routes).toEqual([]);
});

test('failed location validation does not register a project or clear a historical pointer', async () => {
  reset(); render(); const tree = await settle();
  response = async path => path === '/api/location' ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ isDirectory: true });
  choose(tree); const result = await settle();
  expect(registrations).toBe(0); expect(drafts).toEqual([]);
  expect(routes).toEqual([]);
  expect(directory.currentDirectory).toBe('/missing');
  expect(nodes(result).some(node => node.props.role === 'alert')).toBe(true);
});

test('check again preserves confirmed missing state during outage, and resumes a restored directory without relocation', async () => {
  reset(); render(); let tree = await settle();
  response = async () => { throw new Error('offline'); };
  nodes(tree).find(node => node.props.children === 'Check again')!.props.onClick();
  render(); tree = await settle();
  expect(tree.props['data-testid']).toBe('workspace-recovery');
  response = async () => Response.json({ isDirectory: true });
  nodes(tree).find(node => node.props.children === 'Check again')!.props.onClick();
  render(); tree = await settle();
  expect(tree.props.children).toBe('APP');
  expect(directory.currentDirectory).toBe('/missing');
  expect(drafts).toEqual([]); expect(registrations).toBe(0);
});

test('late recovery response from another runtime cannot mutate workspace selection', async () => {
  reset(); render(); const tree = await settle();
  let release!: (value: Response) => void;
  response = () => new Promise(resolve => { release = resolve; });
  choose(tree);
  runtime = 'other'; listener?.();
  release(Response.json({ isDirectory: true }));
  // Subsequent location read is also held until the other runtime is active.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  release(Response.json({ directory: '/homeassistant' }));
  await settle();
  expect(registrations).toBe(0); expect(drafts).toEqual([]);
  expect(directory.currentDirectory).toBe('/missing');
});
