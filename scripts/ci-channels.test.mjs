import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectChannels } from './ci-channels.mjs';
const channels = files => selectChannels(files).include.map(row => row.channel);
test('channel changes do not select the other channel', () => {
  assert.deepEqual(channels(['ha_opencode_beta/Dockerfile']), ['beta']);
  assert.deepEqual(channels(['ha_opencode/rootfs/file.js']), ['stable']);
});
test('shared scripts, workflows and mixed changes exercise both channels', () => {
  for (const files of [['scripts/ci-checks.sh'], ['.github/workflows/pr-checks.yaml'],
    ['ha_opencode_beta/build.yaml', 'ha_opencode/build.yaml']]) {
    assert.deepEqual(channels(files), ['beta', 'stable']);
  }
});
test('manual, initial and empty diffs produce a valid full matrix', () => {
  assert.deepEqual(channels(null), ['beta', 'stable']);
  assert.deepEqual(channels([]), ['beta', 'stable']);
});
