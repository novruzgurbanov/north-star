// Exposes the shared points service (POINTS_PORT, 8888 in v2) through a free Cloudflare quick tunnel.
// Wrapped in Node because npm runs scripts through cmd.exe, which mangles quoted paths with spaces.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const candidates = [
  process.env.CLOUDFLARED,
  'C:\Program Files (x86)\cloudflared\cloudflared.exe',
  'C:\Program Files\cloudflared\cloudflared.exe',
].filter(Boolean);
const bin = candidates.find((p) => existsSync(p)) ?? 'cloudflared';
const port = process.env.POINTS_PORT || '8888';

const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;
const scan = (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (url && !announced) {
    announced = true;
    console.log(`\n  Points service is public at: ${url[0]}\n  Give this URL and the POINTS_KEY from points/.env to the people joining.\n`);
  }
};
child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
