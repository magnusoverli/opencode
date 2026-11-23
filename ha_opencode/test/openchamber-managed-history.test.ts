// Runs against the patched, pinned OpenChamber UI during the image build.
import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { partitionSidebarSessions, projectSidebarActiveSessions } from '../sidebar/list/sessionCollection';
import { HA_HISTORY_WORKSPACE as workspace, hasManagedSessionHistory, openCodeProjectCandidates } from './openCodeProjectCandidates';

test('registering the offered workspace exposes existing history without moving it or admitting unrelated locations', async () => {
  const original = opencodeClient.getFilesystemHomeInfo;
  opencodeClient.getFilesystemHomeInfo = async () => ({
    home: '/home', canonicalChatsRoot: '/HOME/.config/openchamber/chats', canonicalLegacyChatsRoot: '/HOME/.config/openchamber/chats',
  });
  try { await ensureChatsRootDirectory(); } finally { opencodeClient.getFilesystemHomeInfo = original; }
  const records = Array.from({ length: 29 }, (_, i) => ({
    id: `fixture-${i}`, directory: i < 10 ? `/home/.config/openchamber/chats/day/session-${i}` : i < 28 ? workspace : `${workspace}-other`,
    time: { created: 1, updated: 1 },
  } as Session));
  const before = JSON.stringify(records);
  const configured = new Set(['/homeassistant']);
  const list = () => projectSidebarActiveSessions({ globalActiveSessions: records, liveSessions: [], knownDirectories: configured, isVSCode: false });
  const chats = () => partitionSidebarSessions(records, false).chatSessions;
  expect(chats()).toHaveLength(10);
  expect(list()).toHaveLength(0);
  const candidates = openCodeProjectCandidates([], configured, hasManagedSessionHistory(records));
  expect(candidates.map(c => c.path)).toEqual([workspace]);
  configured.add(candidates[0].path); // The existing picker persists this project path.
  expect(list().map(s => s.id)).toEqual(records.slice(10, 28).map(s => s.id));
  expect(chats()).toHaveLength(10);
  expect(openCodeProjectCandidates([], configured, true)).toEqual([]);
  expect(JSON.stringify(records)).toBe(before);
});

test('an unknown or empty session snapshot offers no non-Git workspace', () => {
  const projects = [workspace, `${workspace}-other`].map(worktree => ({
    worktree, vcs: undefined, time: { created: 1, updated: 1 },
  }));
  expect(openCodeProjectCandidates(projects, new Set())).toEqual([]);
  expect(hasManagedSessionHistory(null)).toBe(false);
  expect(hasManagedSessionHistory([])).toBe(false);
  expect(hasManagedSessionHistory([{ directory: `${workspace}-other` }, { directory: workspace, parentID: 'parent' }])).toBe(false);
  expect(openCodeProjectCandidates(projects, new Set(), true).map(c => c.path)).toEqual([workspace]);
});
