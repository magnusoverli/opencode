// Isolated hook harness against the actual patched OpenChamber component (Bun).
// All authorization details are synthetic; no provider or credential API is contacted.
import { afterEach, expect, mock, test } from 'bun:test';

type Node = { type: string; props: Record<string, any> };
let values: any[] = [];
let effects: Array<{ deps: any[]; cleanup?: () => void }> = [];
let pending: Array<() => void> = [];
let index = 0;
let connected = 0;
let statusCalls = 0;
let status = 'pending';
let opens: string[] = [];
let copies: string[] = [];
let cancellations: any[] = [];
let connections: any[] = [];
let successes: string[] = [];
let attempt: any;
const same = (a: any[], b: any[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const React = {
  useState: (initial: any) => {
    const position = index++;
    if (!(position in values)) values[position] = initial;
    return [values[position], (value: any) => { values[position] = value; }];
  },
  useRef: (initial: any) => {
    const position = index++;
    return values[position] ??= { current: initial };
  },
  useCallback: (fn: any, deps: any[]) => {
    const position = index++;
    if (!values[position] || !same(values[position].deps, deps)) values[position] = { fn, deps };
    return values[position].fn;
  },
  useEffect: (effect: () => void | (() => void), deps: any[]) => {
    const position = index++;
    const previous = effects[position];
    if (previous && same(previous.deps, deps)) return;
    pending.push(() => {
      previous?.cleanup?.();
      effects[position] = { deps, cleanup: effect() || undefined };
    });
  },
};
const sdk = { integration: { oauth: {
  connect: async (input: any) => { connections.push(input); return { data: attempt }; },
  status: async () => { statusCalls++; return { data: { status, message: 'Synthetic rejection' } }; },
  cancel: async (input: any) => { cancellations.push(input); },
  complete: async () => { throw new Error('Auto attempts must not submit pasted codes'); },
} } };
mock.module('react', () => ({ default: React, ...React }));
mock.module('react/jsx-runtime', () => ({ jsx: (type: string, props: any) => ({ type, props }), jsxs: (type: string, props: any) => ({ type, props }), Fragment: 'fragment' }));
mock.module('@/components/ui/button', () => ({ Button: 'button' }));
mock.module('@/components/ui/input', () => ({ Input: 'input' }));
mock.module('@/components/ui/spinner', () => ({ Spinner: 'spinner' }));
mock.module('@/components/ui', () => ({ toast: { success: (key: string) => successes.push(key), error: () => {} } }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => ({
  'settings.providers.page.actions.connect': 'Connect', 'settings.providers.page.actions.cancel': 'Cancel',
  'settings.providers.page.actions.copyCode': 'Copy code',
}[key] ?? key) }) }));
mock.module('@/lib/utils', () => ({ cn: (...args: any[]) => args.filter(Boolean).join(' ') }));
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async (value: string) => { copies.push(value); return { ok: true }; } }));
mock.module('@/lib/url', () => ({ openExternalUrl: async (value: string) => { opens.push(value); } }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getSdkClient: () => sdk, getScopedSdkClient: () => sdk } }));
mock.module('./ProviderFormFields', () => ({ ProviderFormFields: 'form-fields' }));
const { ProviderOAuthMethods } = await import('./ProviderOAuthMethods');
const methods = [
  { id: 'chatgpt-token-sharing', type: 'oauth', label: 'Sign in with ChatGPT' },
  { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' },
  { id: 'chatgpt-headless', type: 'oauth', label: 'Codex device code (legacy)' },
];
const nodes = (tree: any): Node[] => {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
};
const render = (integrationId = 'openai') => {
  index = 0;
  const tree = ProviderOAuthMethods({ integrationId, methods: methods as any, onConnected: async () => { connected++; } });
  for (const effect of pending.splice(0)) effect();
  return tree;
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const click = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && node.props.children === label)!.props.onClick();
const begin = (label: string) => {
  const section = nodes(render()).find(node => node.props?.className === 'space-y-3' && nodes(node).some(child => child.props?.children === label));
  click(section, 'Connect');
};
function reset() {
  values = []; effects = []; pending = []; index = 0;
  connected = 0; statusCalls = 0; status = 'pending'; opens = []; copies = [];
  cancellations = []; connections = []; successes = [];
  attempt = { attemptID: 'fixture-attempt', mode: 'auto', url: 'https://auth.openai.com/codex/device', instructions: 'Enter code: ABCD-12345' };
}
afterEach(() => { for (const effect of effects) effect?.cleanup?.(); });

test('guidance distinguishes legacy device code from newer ChatGPT without reordering or starting any method', () => {
  reset();
  const tree = render();
  expect(nodes(tree).some(node => node.props?.['data-testid'] === 'ha-openai-signin-guidance')).toBe(true);
  expect(nodes(tree).filter(node => node.props?.className === 'typography-ui-label text-foreground').map(node => node.props.children)).toEqual(methods.map(method => method.label));
  expect(connections).toEqual([]);
  expect(nodes(render('other-provider')).some(node => node.props?.['data-testid'] === 'ha-openai-signin-guidance')).toBe(false);
});

test('device login shows/copies the code, polls automatically and refreshes only after completion', async () => {
  reset(); begin('Codex device code (legacy)');
  const tree = await settle();
  expect(connections).toEqual([{ integrationID: 'openai', methodID: 'chatgpt-headless' }]);
  expect(opens).toEqual(['https://auth.openai.com/codex/device']);
  expect(nodes(tree).some(node => node.type === 'input' && node.props.value === 'ABCD-12345' && node.props.readOnly)).toBe(true);
  await click(tree, 'Copy code');
  expect(copies).toEqual(['ABCD-12345']);
  expect(connected).toBe(0);
  status = 'complete';
  await Bun.sleep(1600); await settle();
  expect(statusCalls).toBe(1);
  expect(connected).toBe(1);
  expect(successes).toContain('settings.providers.page.toast.oauthCompleted');
  expect(cancellations).toEqual([]);
});

test('newer ChatGPT preserves its own method and handoff, then refreshes automatically', async () => {
  reset();
  attempt = { ...attempt, url: 'https://ha.example/api/hassio_ingress/fixture/__ha_openai_oauth_bridge?id=fixture', instructions: 'Use the handoff.' };
  begin('Sign in with ChatGPT'); await settle();
  expect(connections[0].methodID).toBe('chatgpt-token-sharing');
  expect(opens).toEqual([attempt.url]);
  status = 'complete';
  await Bun.sleep(1600); await settle();
  expect(connected).toBe(1);
  expect(copies).toEqual([]);
});

test('cancel and leaving the screen release upstream attempts without reporting success', async () => {
  reset(); begin('Codex device code (legacy)');
  click(await settle(), 'Cancel');
  expect(cancellations).toEqual([{ integrationID: 'openai', attemptID: 'fixture-attempt' }]);
  await Bun.sleep(1600); await settle();
  expect(statusCalls).toBe(0);
  expect(connected).toBe(0);
  begin('Codex device code (legacy)'); await settle();
  for (const effect of effects) effect?.cleanup?.();
  expect(cancellations.length).toBe(2);
  await Bun.sleep(1600);
  expect(statusCalls).toBe(0);
});

test('a failed attempt is shown without refreshing provider state or claiming success', async () => {
  reset(); begin('Codex device code (legacy)'); await settle();
  status = 'failed';
  await Bun.sleep(1600);
  const tree = await settle();
  expect(nodes(tree).some(node => node.props?.children === 'Synthetic rejection')).toBe(true);
  expect(connected).toBe(0);
  expect(successes).toEqual([]);
});
