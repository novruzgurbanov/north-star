/**
 * Acceptance checks for per-goal visibility, user color and publishing public
 * goals (BRIEF-visibility.md). Self-contained: it starts a tiny stub points
 * service on :8797 and the API server on :8794 (never 8787/8788), runs both
 * phases, deletes the throwaway user(s) and stops everything again.
 *
 *   npx tsx scripts/visibility-test.ts
 *
 * Phase 1 — API server with POINTS_URL=http://localhost:9 (points unreachable,
 *           fail soft): goal visibility default, PATCH visibility, PATCH color.
 * Phase 2 — API server restarted with POINTS_URL=http://localhost:8797 (the
 *           stub): PUT /v1/players/:id/goals must carry only the public goals.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { close } from '../src/db.js';
import { deleteNonSeededUsersByName } from '../src/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NAME = 'Zz Visibility Test';
const NAME2 = 'Zz Visibility Test Two';
const PORT = 8794; // API server (never 8787/8788)
const STUB_PORT = 8797; // stub points service
const BASE = `http://localhost:${PORT}`;
const DEAD_POINTS = 'http://localhost:9';
const STUB_PLAYER_ID = 'stub-player-1';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function callApi(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000), // chat capture can take a while
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function portFree(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

// ---------------------------------------------------------------------------
// API server child process (node --import tsx src/index.ts)
// ---------------------------------------------------------------------------

function startApi(pointsUrl: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, API_PORT: String(PORT), POINTS_URL: pointsUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(String(d).replace(/^/gm, '[api] ')));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(String(d).replace(/^/gm, '[api] ')));
  child.on('error', (err) => console.error(`[api] spawn error: ${err.message}`));
  return child;
}

async function stopApi(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5000);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await portFree(PORT))) await sleep(300);
}

async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        if (json?.ok === true) {
          if (json.neo4j !== true) throw new Error('API is up but neo4j is unreachable');
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'API is up but neo4j is unreachable') throw err;
    }
    await sleep(500);
  }
  throw new Error(`API server did not come up on ${PORT}`);
}

// ---------------------------------------------------------------------------
// Tiny stub points service (records what the server sends; fail-soft target)
// ---------------------------------------------------------------------------

const stub = {
  putGoalsCalls: [] as Array<{ playerId: string; goals: any[] }>,
  playerPatches: [] as Array<{ id: string; body: any }>,
  server: null as http.Server | null,
  // minimal state so GET /v1/players/:id can echo back goalTitle/color
  goalTitle: null as string | null,
  color: '#ffffff',
};

function startStub(): Promise<void> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = Buffer.concat(chunks).toString('utf8') ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        body = {};
      }
      const url = req.url ?? '';
      const row = () => ({
        id: STUB_PLAYER_ID,
        name: 'Stub',
        color: stub.color,
        goalTitle: stub.goalTitle,
        createdAt: new Date().toISOString(),
        rank: 1,
        points: 0,
        focusedMinutes: 0,
        todayMinutes: 0,
        streak: 0,
        lastActiveAt: null,
        live: false,
        sources: ['north-star'],
        goals: [],
      });
      if (req.method === 'POST' && url === '/v1/players') {
        if ('goalTitle' in body) stub.goalTitle = body.goalTitle ?? null;
        if (typeof body.color === 'string') stub.color = body.color;
        send(200, { player: { id: STUB_PLAYER_ID, name: String(body.name ?? 'Stub'), color: stub.color, goalTitle: stub.goalTitle, createdAt: new Date().toISOString() } });
        return;
      }
      if (req.method === 'PATCH' && url.startsWith('/v1/players/')) {
        const id = decodeURIComponent(url.split('/')[3] ?? '');
        stub.playerPatches.push({ id, body });
        if ('goalTitle' in body) stub.goalTitle = body.goalTitle ?? null;
        if (typeof body.color === 'string') stub.color = body.color;
        send(200, { player: { id, name: 'Stub', color: stub.color, goalTitle: stub.goalTitle, createdAt: new Date().toISOString() } });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/v1/players/')) {
        send(200, { row: row() });
        return;
      }
      if (req.method === 'PUT' && url.startsWith('/v1/players/') && url.endsWith('/goals')) {
        const id = decodeURIComponent(url.split('/')[3] ?? '');
        const goals = Array.isArray(body.goals) ? body.goals : [];
        stub.putGoalsCalls.push({ playerId: id, goals });
        send(200, { row: { ...row(), goals } });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/v1/leaderboard')) {
        send(200, { rows: [] });
        return;
      }
      send(404, { error: 'stub: not found' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STUB_PORT, () => {
      stub.server = server;
      resolve();
    });
  });
}

function stopStub(): Promise<void> {
  return new Promise((resolve) => {
    if (!stub.server) return resolve();
    stub.server.close(() => resolve());
    stub.server = null;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createGoalViaChat(userId: string, message: string): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, json } = await callApi('POST', '/api/chat', {
      userId,
      messages: [{ role: 'user', content: message }],
    });
    const created = (json?.events ?? []).find((e: any) => e?.type === 'goal_created');
    if (status === 200 && created?.goal?.id) return created.goal;
    console.log(`    [chat attempt ${attempt}] status=${status} error=${JSON.stringify(json?.error ?? json?.reply ?? '')}`);
    await sleep(500);
  }
  throw new Error(`chat did not create a goal for: ${message}`);
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(200);
  }
  console.error(`  (timeout waiting for ${label})`);
  return false;
}

/** Wait until the stub has seen no new PUT goals calls for ~1 s. */
async function quiesce(): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = stub.putGoalsCalls.length;
  let stableFor = 0;
  while (Date.now() < deadline) {
    await sleep(300);
    if (stub.putGoalsCalls.length === last) {
      stableFor += 300;
      if (stableFor >= 900) return;
    } else {
      last = stub.putGoalsCalls.length;
      stableFor = 0;
    }
  }
}

const goalIds = (call: { goals: any[] }): string[] => call.goals.map((g: any) => g.id);

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('0. pre-flight: ports free, leftover test users removed');
  check(await portFree(PORT), `port ${PORT} free before start`);
  check(await portFree(STUB_PORT), `port ${STUB_PORT} free before start`);
  const removed0 = (await deleteNonSeededUsersByName(NAME).catch(() => 0)) + (await deleteNonSeededUsersByName(NAME2).catch(() => 0));
  console.log(`    leftovers removed: ${removed0}`);

  // ---------------------------------------------------------------------------
  // PHASE 1 — points service unreachable (fail soft)
  // ---------------------------------------------------------------------------
  console.log(`\nPHASE 1 — API on :${PORT}, POINTS_URL=${DEAD_POINTS} (fail soft)`);
  let apiProc: ChildProcess | null = null;
  apiProc = startApi(DEAD_POINTS);
  await waitForApi();
  console.log('    API server is up');

  console.log('1. create the throwaway user');
  let userId = '';
  {
    const { status, json } = await callApi('POST', '/api/users', { name: NAME });
    check(status === 200 && json?.user?.id, 'POST /api/users', json?.user?.id ?? json?.error);
    userId = json?.user?.id ?? '';
  }

  console.log('2. a new goal is public by default');
  let goal1: any = null;
  {
    goal1 = await createGoalViaChat(userId, 'I want to finish my thesis draft because I want to graduate this year');
    check(goal1?.public === true, 'chat-created goal is public by default', JSON.stringify(goal1?.public));
    const { json } = await callApi('GET', `/api/users/${userId}`);
    const fetched = (json?.goals ?? []).find((g: any) => g.id === goal1.id);
    check(fetched?.public === true, 'GET /api/users/:id shows public true', JSON.stringify(fetched?.public));
  }

  console.log('3. PATCH the goal to private -> public:false, persists');
  {
    const { status, json } = await callApi('PATCH', `/api/goals/${goal1.id}`, { userId, public: false });
    check(status === 200, 'HTTP 200', `${status} ${JSON.stringify(json?.error ?? '')}`);
    check(json?.goal?.public === false, 'PATCH returns public:false', JSON.stringify(json?.goal?.public));
    const { json: again } = await callApi('GET', `/api/users/${userId}`);
    const fetched = (again?.goals ?? []).find((g: any) => g.id === goal1.id);
    check(fetched?.public === false, 'private persists on GET', JSON.stringify(fetched?.public));
  }

  console.log('4. PATCH visibility of an unknown goal -> 404');
  {
    const { status } = await callApi('PATCH', '/api/goals/nope', { userId, public: true });
    check(status === 404, 'HTTP 404', String(status));
  }

  console.log('5. shareGoalTitle off -> new goals are born private (setting back on afterwards)');
  let goal2: any = null;
  {
    const put = await callApi('PUT', `/api/users/${userId}/settings`, { shareGoalTitle: false });
    check(put.status === 200 && put.json?.settings?.shareGoalTitle === false, 'shareGoalTitle=false saved', JSON.stringify(put.json?.settings?.shareGoalTitle));
    goal2 = await createGoalViaChat(userId, 'I want to read one book every month to relax');
    check(goal2?.public === false, 'new goal private while shareGoalTitle is off', JSON.stringify(goal2?.public));
    const back = await callApi('PUT', `/api/users/${userId}/settings`, { shareGoalTitle: true });
    check(back.status === 200 && back.json?.settings?.shareGoalTitle === true, 'shareGoalTitle back on');
  }

  console.log('6. PATCH user color');
  {
    const ok = await callApi('PATCH', `/api/users/${userId}`, { color: '#12abEF' });
    check(ok.status === 200 && ok.json?.user?.color === '#12abEF', 'valid hex -> user returned with the new color', JSON.stringify(ok.json?.user?.color));
    const bad = await callApi('PATCH', `/api/users/${userId}`, { color: 'red' });
    check(bad.status === 400, 'invalid color "red" -> 400', String(bad.status));
    const short = await callApi('PATCH', `/api/users/${userId}`, { color: '#12abE' });
    check(short.status === 400, 'invalid color "#12abE" (5 digits) -> 400', String(short.status));
    const { json } = await callApi('GET', `/api/users/${userId}`);
    check(json?.user?.color === '#12abEF', 'color persisted', JSON.stringify(json?.user?.color));
  }

  await stopApi(apiProc);
  apiProc = null;

  // ---------------------------------------------------------------------------
  // PHASE 2 — stub points service, PUT /v1/players/:id/goals verification
  // ---------------------------------------------------------------------------
  console.log(`\nPHASE 2 — API on :${PORT}, POINTS_URL=http://localhost:${STUB_PORT} (stub)`);
  await startStub();
  apiProc = startApi(`http://localhost:${STUB_PORT}`);
  await waitForApi();
  console.log('    API server is up (stub points service on :8797)');

  console.log('7. GET /api/users/:id syncs public goals (none public yet -> empty list)');
  {
    const before = stub.putGoalsCalls.length;
    await callApi('GET', `/api/users/${userId}`); // the only goal (goal1) is private
    const called = await waitFor(() => stub.putGoalsCalls.length > before, 15_000, 'PUT goals after GET');
    check(called, 'PUT /v1/players/:id/goals called for an existing user', `${stub.putGoalsCalls.length - before} new call(s)`);
    const last = stub.putGoalsCalls.at(-1);
    check(Array.isArray(last?.goals) && last!.goals.length === 0, 'no public goals yet -> empty list', JSON.stringify(last?.goals));
    check(last?.playerId === STUB_PLAYER_ID, 'published to the player from the points service', last?.playerId);
  }

  console.log('8. two more goals via chat (both public by default)');
  const goal3 = await createGoalViaChat(userId, 'I want to run a half marathon in spring because I love running');
  const goal4 = await createGoalViaChat(userId, 'I want to build a wooden birdhouse for my garden this winter');
  check(goal3?.public === true && goal4?.public === true, 'both new goals public by default', `${goal3?.public}/${goal4?.public}`);
  await quiesce();

  console.log('9. visibility change -> PUT carries only the still-public goal');
  let putCallsAtPrivatePatch = 0;
  {
    await quiesce();
    const before = stub.putGoalsCalls.length;
    putCallsAtPrivatePatch = before;
    const patch = await callApi('PATCH', `/api/goals/${goal4.id}`, { userId, public: false });
    check(patch.status === 200 && patch.json?.goal?.public === false, 'goal 4 now private', JSON.stringify(patch.json?.goal?.public));
    const called = await waitFor(() => stub.putGoalsCalls.length > before, 15_000, 'PUT goals after PATCH');
    check(called, 'PUT called after the visibility change');
    const saw = await waitFor(
      () => stub.putGoalsCalls.slice(before).some((c) => JSON.stringify(goalIds(c)) === JSON.stringify([goal3.id])),
      15_000,
      'PUT carrying only goal3'
    );
    check(saw, 'PUT carries exactly the still-public goal', JSON.stringify(stub.putGoalsCalls.slice(before).map(goalIds)));
    await quiesce();
    const last = stub.putGoalsCalls.at(-1);
    const shape = last?.goals?.[0] ?? null;
    check(
      shape !== null &&
        JSON.stringify(Object.keys(shape).sort()) ===
          JSON.stringify(['brightness', 'id', 'milestonesDone', 'milestonesTotal', 'status', 'title']),
      'PublicGoal shape { id, title, status, brightness, milestonesDone, milestonesTotal }',
      JSON.stringify(shape)
    );
    check(
      shape?.id === goal3.id &&
        shape?.title === goal3.title &&
        shape?.status === goal3.status &&
        shape?.milestonesDone === 0 &&
        shape?.milestonesTotal === 0 &&
        typeof shape?.brightness === 'number' &&
        shape.brightness >= 0 &&
        shape.brightness <= 1,
      'payload fields match the public goal',
      JSON.stringify(shape)
    );
  }

  console.log('10. private goals never published; color + legacy title reach the points player');
  {
    const neverPublic = [goal1.id, goal2.id];
    const leak = stub.putGoalsCalls.some((c) => goalIds(c).some((id) => neverPublic.includes(id)));
    check(!leak, 'private-from-birth goals never appear in any published list');
    const afterPatch = stub.putGoalsCalls.slice(putCallsAtPrivatePatch);
    check(!afterPatch.some((c) => goalIds(c).includes(goal4.id)), 'goal 4 not published again after going private');

    const patch = await callApi('PATCH', `/api/users/${userId}`, { color: '#00ff00' });
    check(patch.status === 200 && patch.json?.user?.color === '#00ff00', 'user color updated', JSON.stringify(patch.json?.user?.color));
    const colorPatched = await waitFor(
      () => stub.playerPatches.some((p) => p.id === STUB_PLAYER_ID && p.body?.color === '#00ff00'),
      15_000,
      'points player color PATCH'
    );
    check(colorPatched, 'points player color updated via PATCH /v1/players/:id', JSON.stringify(stub.playerPatches.map((p) => p.body)));
    const titleCleared = await waitFor(
      () => stub.playerPatches.some((p) => p.id === STUB_PLAYER_ID && 'goalTitle' in p.body && p.body.goalTitle === null),
      15_000,
      'legacy goalTitle cleared'
    );
    check(titleCleared, 'legacy leaderboard title cleared when its goal went private');
  }

  console.log('11. GET /api/users/:id sync is throttled to once per 60 s per user');
  {
    const { status, json } = await callApi('POST', '/api/users', { name: NAME2 });
    check(status === 200 && json?.user?.id, 'second throwaway user', json?.user?.id ?? json?.error);
    const user2 = json?.user?.id ?? '';
    const before = stub.putGoalsCalls.length;
    await callApi('GET', `/api/users/${user2}`); // first GET for user2 -> sync (no goals -> empty list)
    const called = await waitFor(() => stub.putGoalsCalls.length > before, 15_000, 'PUT goals for user2');
    check(called, 'first GET triggers the sync');
    const afterFirst = stub.putGoalsCalls.length;
    await callApi('GET', `/api/users/${user2}`);
    await callApi('GET', `/api/users/${user2}`);
    await sleep(1500);
    check(stub.putGoalsCalls.length === afterFirst, 'GETs within 60 s do not sync again', `${stub.putGoalsCalls.length - afterFirst} extra call(s)`);
  }

  console.log('12. cleanup: delete users, stop servers, ports free');
  {
    const removed = (await deleteNonSeededUsersByName(NAME)) + (await deleteNonSeededUsersByName(NAME2));
    check(removed >= 2, 'test users deleted', String(removed));
  }
  await stopApi(apiProc);
  apiProc = null;
  await stopStub();
  check(await portFree(PORT), `port ${PORT} free again`);
  check(await portFree(STUB_PORT), `port ${STUB_PORT} free again`);

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all visibility acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('visibility test crashed:', err);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    await deleteNonSeededUsersByName(NAME2).catch(() => undefined);
    await close().catch(() => undefined);
    process.exit(1);
  });
