// Copies POINTS_KEY from points/.env to the clipboard without printing it.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const line = readFileSync(new URL('../points/.env', import.meta.url), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('POINTS_KEY='));
const key = line?.slice('POINTS_KEY='.length).trim();
if (!key) { console.error('No POINTS_KEY in points/.env'); process.exit(1); }
const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
const res = spawnSync(cmd, args, { input: key });
if (res.status !== 0) { console.error('Could not reach the clipboard.'); process.exit(1); }
console.log(`POINTS_KEY copied to the clipboard (${key.length} characters). Share it privately.`);
