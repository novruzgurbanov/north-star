import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const requests = [];
const observations = [];
const diagnostics = [];
let electron;
let launchError = null;
let timedOut = false;

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>North Star self-test</title>
<style>body{background:#020309;color:#c9d4f2;font:24px system-ui;padding:64px}header{-webkit-app-region:drag;height:40px}</style>
<header></header><h1>North Star desktop self-test</h1><p>Checking the sandboxed bridge and primary-screen capture.</p>
<pre id="state">Starting…</pre><script>
(async () => {
  const bridge = window.northStarDesktop;
  if (!bridge || bridge.isDesktop !== true || typeof bridge.platform !== 'string') throw new Error('Bridge missing');
  for (const name of ['start','pause','resume','stop','setCamera','getState','onState']) {
    if (typeof bridge.focus[name] !== 'function') throw new Error('Bridge method missing: ' + name);
  }
  let before = await bridge.focus.getState();
  await bridge.focus.start({ userId: '', goalId: 'invalid', goalTitle: 'invalid', camera: false });
  if ((await bridge.focus.getState()).status !== before.status) throw new Error('Invalid IPC was accepted');
  const unsubscribe = bridge.focus.onState((state) => {
    const summary = { status: state.status, checks: state.checks,
      verdict: state.lastCheck?.verdict || null, error: state.error,
      cameraEnabled: state.cameraEnabled, cameraActive: state.cameraActive };
    console.log('NORTH_STAR_SELFTEST_STATE ' + JSON.stringify(summary));
    document.getElementById('state').textContent = JSON.stringify(summary, null, 2);
    fetch('/observed', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(summary)});
  });
  if (typeof unsubscribe !== 'function') throw new Error('Missing unsubscribe');
  const state = await bridge.focus.start({userId:'selftest-user',goalId:'selftest-goal',
    goalTitle:'Build the North Star desktop shell',camera:false});
  if (state.status !== 'active') throw new Error('Start did not return active state');
})().catch((error) => {
  console.log('NORTH_STAR_SELFTEST_ERROR ' + error.message);
  fetch('/observed', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({error:error.message})});
});
</script></html>`;

async function readJSON(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  const json = (value) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    } else if (request.method === 'POST' && request.url === '/api/focus/check') {
      let body = await readJSON(request, 8 * 1024 * 1024);
      let image = typeof body.screen === 'string' ? Buffer.from(body.screen, 'base64') : Buffer.alloc(0);
      const jpeg = image.length > 4 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
        && image.at(-2) === 0xff && image.at(-1) === 0xd9;
      requests.push({ jpeg, bytes: image.length, cameraOff: body.camera == null,
        sinceSeconds: body.sinceSeconds, userId: body.userId, goalId: body.goalId });
      const countedSeconds = body.sinceSeconds;
      // Images stay in memory only while handling this request; never print them.
      body = null;
      image = null;
      const onTrack = requests.length % 2 === 1;
      json({ verdict: onTrack ? 'on_track' : 'off_track', confidence: 0.9,
        reason: onTrack ? "You're building your app." : "You're looking away from your goal.",
        nudge: onTrack ? '' : 'Come back to your star.',
        roast: onTrack ? '' : 'That tab is not your star.',
        counted: onTrack,
        countedSeconds: onTrack ? countedSeconds : 0,
        goal: { id: 'selftest-goal' }, stats: { score: 1 }, points: null });
    } else if (request.method === 'POST' && request.url === '/observed') {
      const body = await readJSON(request, 4_096);
      observations.push(body);
      json({ ok: true });
      if (body.status === 'error' || (body.error && !body.status)) electron?.kill();
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch {
    response.writeHead(400);
    response.end('Invalid test request');
  }
});

function diagnostic(chunk) {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (diagnostics.length < 30) diagnostics.push(line.slice(0, 500));
    if (/^(\[focus\]|NORTH_STAR_SELFTEST_)/.test(line)) console.log(line.slice(0, 500));
  }
}

let exitCode = null;
let exitSignal = null;
let timeout;
try {
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(8799, '127.0.0.1', yes);
  });
  console.log('Self-test mock listening on http://localhost:8799 (camera off).');
  const env = { ...process.env, API_URL: 'http://localhost:8799', WEB_URL: 'http://localhost:8799',
    CHECK_SECONDS: '10', NORTH_STAR_SELFTEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done) => {
    electron = spawn(require('electron'), ['.'], { cwd: ROOT, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    electron.stdout.on('data', diagnostic);
    electron.stderr.on('data', diagnostic);
    electron.once('error', (error) => { launchError = `${error.code || 'error'}: ${error.message}`; done(); });
    electron.once('close', (code, signal) => { exitCode = code; exitSignal = signal; done(); });
    timeout = setTimeout(() => { timedOut = true; electron.kill(); }, 75_000);
  });
} catch (error) {
  launchError = `${error.code || 'error'}: ${error.message}`;
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

const active = observations.filter((state) => state.status === 'active' && state.verdict);
const checks = {
  'Electron exited normally after two checks': !launchError && !timedOut && exitCode === 0,
  'Mock received exactly two focus requests': requests.length === 2,
  'Both screens decode to non-empty JPEGs': requests.length === 2 && requests.every((item) => item.jpeg),
  'Camera remained off and request IDs match': requests.length === 2 && requests.every((item) =>
    item.cameraOff && item.userId === 'selftest-user' && item.goalId === 'selftest-goal'),
  'sinceSeconds is within 5..900': requests.length === 2 && requests.every((item) =>
    Number.isFinite(item.sinceSeconds) && item.sinceSeconds >= 5 && item.sinceSeconds <= 900),
  'Page received active states with both verdicts': active.some((state) => state.verdict === 'on_track')
    && active.some((state) => state.verdict === 'off_track' && state.checks === 2),
};
for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
const passed = Object.values(checks).every(Boolean);
if (!passed) {
  if (launchError) console.log(`Launch/server failure: ${launchError}`);
  console.log(`Electron exit: ${exitCode}; signal: ${exitSignal}; timed out: ${timedOut}`);
  for (const state of observations.filter((state) => state.error)) console.log(`Observed error: ${state.error}`);
  for (const line of diagnostics.filter((line) => !/^(\[focus\]|NORTH_STAR_SELFTEST_)/.test(line))) {
    console.log(`Electron diagnostic: ${line}`);
  }
}
console.log(`${passed ? 'PASS' : 'FAIL'} North Star desktop self-test (${requests.length} requests, ${observations.length} page states).`);
process.exitCode = passed ? 0 : 1;
