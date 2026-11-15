// Shared changes exercise both channels; channel-only changes stay isolated.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const all = [{ channel: 'beta', addon: 'ha_opencode_beta' }, { channel: 'stable', addon: 'ha_opencode' }];
export function selectChannels(files) {
  const shared = !files?.length || files.some(file => !/^ha_opencode(?:_beta)?\//.test(file) ||
    file === 'ha_opencode_beta/test/opencode-v2-dependency-security.test.js');
  return { include: all.filter(({ addon }) => shared || files.some(file => file.startsWith(`${addon}/`))) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  const files = !base || /^0+$/.test(base) ? null :
    execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const matrix = JSON.stringify(selectChannels(files));
  console.log(matrix);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}
