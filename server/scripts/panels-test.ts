/**
 * End-to-end checks for AI-built goal panels (../../PANELS.md). Self-contained: it
 * starts the API server on :8897 with POINTS_URL=http://localhost:9 (the points
 * service is unreachable on purpose; every points call fails soft), runs the checks
 * with a throwaway user "Zz Panels Test" (plus "Zz Panels Other" for the 404s),
 * deletes both and stops the server again. Never binds 5173/8787/8788 or 5273/8887/8888.
 *
 *   npx tsx scripts/panels-test.ts
 *
 * The AI parts (design, edit, proof, coach) call the real models, so a run takes a
 * few minutes. Designed specs are printed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, loadFont } from 'jimp';
import { SANS_32_BLACK, SANS_32_WHITE, SANS_64_BLACK } from 'jimp/fonts';
import { close, run } from '../src/db.js';
import {
  addDetail,
  createGoal,
  deleteNonSeededUsersByName,
  logCheckin,
  savePanel,
  sweepOrphanEntries,
  updateGoalDetails,
} from '../src/model.js';
import { sanitizePanel } from '../src/panel.js';
import type { Field, LogWidget, PanelSpec, Widget } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NAME = 'Zz Panels Test';
const OTHER = 'Zz Panels Other';
const PORT = 8897; // test API server (never 8787/8788 or 8887/8888)
const BASE = `http://localhost:${PORT}`;
const DEAD_POINTS = 'http://localhost:9';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function api(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240_000), // design/edit/proof call the AI (two attempts max)
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

function startApi(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, API_PORT: String(PORT), POINTS_URL: DEAD_POINTS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Only our own short log lines ([panel], [proof]); points fail-soft noise is dropped.
  const relay = (d: Buffer) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (/^\[(panel|proof|error)\]|listening/.test(line)) console.log(`    [api] ${line}`);
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);
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

async function waitForApi(timeoutMs = 90_000): Promise<void> {
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
// Helpers
// ---------------------------------------------------------------------------

function describeWidget(w: Widget): string {
  const t = `${w.id} ${w.type} "${w.title}"`;
  switch (w.type) {
    case 'focus_session':
      return `${t} minutes=[${w.minutes.join(', ')}]`;
    case 'log':
      return `${t} fields=[${w.fields
        .map((f) => `${f.key}:${f.kind}${f.unit ? `(${f.unit})` : ''}${f.required ? '*' : ''} "${f.label}"`)
        .join(', ')}] proof=${w.proof}${w.proofHint ? ` hint="${w.proofHint}"` : ''}`;
    case 'streak':
      return `${t} <- ${w.source} ${w.cadence} x${w.perPeriod}`;
    case 'counter':
      return `${t} <- ${w.source}.${w.field} target=${w.target} ${w.unit} per ${w.period}`;
    case 'chart':
      return `${t} <- ${w.source}.${w.field} ${w.unit} by ${w.period} x${w.span}`;
    case 'habit_grid':
      return `${t} <- ${w.source} days=${w.days}`;
    case 'checklist':
      return `${t} items=[${w.items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('; ')}]`;
    case 'countdown':
      return `${t} ${w.date} "${w.label}"`;
    case 'note':
      return `${t} "${w.text.replace(/\n/g, ' / ')}"`;
    default:
      return t;
  }
}

function printSpec(label: string, spec: PanelSpec | null): void {
  if (!spec) {
    console.log(`    [${label}] (no panel)`);
    return;
  }
  console.log(`    [${label}] v${spec.version} profile=${spec.profile} summary=${JSON.stringify(spec.summary)}`);
  for (const w of spec.widgets) console.log(`      - ${describeWidget(w)}`);
}

const logsOf = (spec: PanelSpec | null): LogWidget[] =>
  (spec?.widgets ?? []).filter((w): w is LogWidget => w.type === 'log');

/** A field that looks like distance (key/label/unit), else the first number field. */
function distanceField(log: LogWidget): Field | undefined {
  const numeric = log.fields.filter((f) => f.kind === 'number');
  return numeric.find((f) => /dist|km|kilomet/i.test(`${f.key} ${f.label} ${f.unit ?? ''}`)) ?? numeric[0];
}

/** Valid values for every field of a log (distance 6.2, minutes 34, rating 4, ...). */
function validValues(log: LogWidget, distance = 6.2, minutes = 34): Record<string, unknown> {
  const dist = distanceField(log);
  const out: Record<string, unknown> = {};
  for (const f of log.fields) {
    if (f.kind === 'minutes') out[f.key] = minutes;
    else if (f.kind === 'number') out[f.key] = f === dist ? distance : 3;
    else if (f.kind === 'rating') out[f.key] = 4;
    else if (f.kind === 'boolean') out[f.key] = true;
    else out[f.key] = 'Park loop';
  }
  return out;
}

/** A Strava-like activity screenshot, drawn in memory. */
async function stravaJpeg(): Promise<string> {
  const img = new Jimp({ width: 720, height: 1080, color: 0xffffffff });
  const header = new Jimp({ width: 720, height: 150, color: 0xfc4c02ff });
  img.composite(header, 0, 0);
  const white32 = await loadFont(SANS_32_WHITE);
  const black64 = await loadFont(SANS_64_BLACK);
  const black32 = await loadFont(SANS_32_BLACK);
  img.print({ font: white32, x: 40, y: 55, text: 'STRAVA' });
  img.print({ font: black64, x: 40, y: 200, text: 'Morning Run' });
  img.print({ font: black32, x: 40, y: 290, text: 'Today at 7:12 AM - Riverside Park' });
  img.print({ font: black32, x: 40, y: 400, text: 'Distance' });
  img.print({ font: black64, x: 40, y: 440, text: '6.2 km' });
  img.print({ font: black32, x: 380, y: 400, text: 'Moving Time' });
  img.print({ font: black64, x: 380, y: 440, text: '34:10' });
  img.print({ font: black32, x: 40, y: 580, text: 'Pace' });
  img.print({ font: black64, x: 40, y: 620, text: '5:31 /km' });
  img.print({ font: black32, x: 40, y: 780, text: 'Strava - Morning Run - 6.2 km - 34:10' });
  const buf = await img.getBuffer('image/jpeg', { quality: 85 });
  return buf.toString('base64');
}

/** Something unrelated to running: a grocery list. */
async function unrelatedJpeg(): Promise<string> {
  const img = new Jimp({ width: 720, height: 720, color: 0xf3efe0ff });
  const black64 = await loadFont(SANS_64_BLACK);
  const black32 = await loadFont(SANS_32_BLACK);
  img.print({ font: black64, x: 40, y: 60, text: 'Grocery list' });
  ['- 2 avocados', '- oat milk', '- dish soap', '- coffee beans', '- birthday card for Anna'].forEach((line, i) =>
    img.print({ font: black32, x: 60, y: 200 + i * 70, text: line })
  );
  const buf = await img.getBuffer('image/jpeg', { quality: 85 });
  return buf.toString('base64');
}

async function entryCount(ids: string[]): Promise<number> {
  const rows = await run('MATCH (e: NSEntry) WHERE e.id IN $ids RETURN count(e) AS c', { ids });
  return Number(rows[0]?.c ?? 0);
}

async function orphanEntries(): Promise<number> {
  const rows = await run('MATCH (e: NSEntry) WHERE NOT ()-[:HAS_ENTRY]->(e) RETURN count(e) AS c');
  return Number(rows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

let apiProc: ChildProcess | null = null;

async function main(): Promise<void> {
  console.log(`0. start the API server on :${PORT} (points unreachable on purpose)`);
  check(await portFree(PORT), `port ${PORT} is free`);
  apiProc = startApi();
  await waitForApi();
  check(true, 'API server up, neo4j reachable');
  await deleteNonSeededUsersByName(NAME);
  await deleteNonSeededUsersByName(OTHER);

  console.log('1. throwaway users');
  const u = await api('POST', '/api/users', { name: NAME });
  const userId: string = u.json?.user?.id ?? '';
  const o = await api('POST', '/api/users', { name: OTHER });
  const otherId: string = o.json?.user?.id ?? '';
  check(Boolean(userId && otherId), 'users created', `${userId}, ${otherId}`);

  console.log('2. two ready goals (running, thesis) through the model');
  const runGoal = await createGoal(userId, {
    title: 'Run my first marathon',
    why: 'My dad ran one at 50 and I want to share that with him',
    successLooksLike: '',
    deadline: '2027-09-26',
    milestones: ['Run 5 km without stopping', 'Run 10 km comfortably', 'Finish a half marathon', 'Do a 30 km long run'],
  });
  const runId = runGoal?.id ?? '';
  await updateGoalDetails(userId, runId, { successLooksLike: 'I finish the Berlin marathon in under 4:30' });
  await addDetail(userId, runId, 'obstacle', 'Knee pain after long runs');
  await addDetail(userId, runId, 'action', 'Run three mornings a week before work');
  const thesisGoal = await createGoal(userId, {
    title: "Finish my master's thesis",
    why: 'Graduate this spring and start my job',
    successLooksLike: '',
    deadline: '2027-03-01',
    milestones: ['Finish the literature review', 'Run the experiments', 'Write the results chapter', 'Submit the final draft'],
  });
  const thesisId = thesisGoal?.id ?? '';
  await updateGoalDetails(userId, thesisId, { successLooksLike: 'My advisor approves the full draft' });
  await addDetail(userId, thesisId, 'on_track', 'Writing in Overleaf');
  await addDetail(userId, thesisId, 'distraction', 'YouTube');
  check(Boolean(runId && thesisId), 'goals created', `${runId}, ${thesisId}`);

  console.log('3. GET /api/users/:id: goals carry panel: null and entries: []');
  {
    const { status, json } = await api('GET', `/api/users/${userId}`);
    const g = (json?.goals ?? []).find((x: any) => x.id === runId);
    check(status === 200 && g?.panel === null && Array.isArray(g?.entries) && g.entries.length === 0, 'new goal has no panel yet', `${g?.panel}`);
  }

  console.log('4. POST /panel/design for the running goal');
  let runPanel: PanelSpec | null = null;
  {
    const { status, json } = await api('POST', `/api/goals/${runId}/panel/design`, { userId });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    runPanel = json?.goal?.panel ?? null;
    printSpec('running design', runPanel);
    console.log(`    [running design json] ${JSON.stringify(runPanel)}`);
    const types = (runPanel?.widgets ?? []).map((w) => w.type);
    check(!types.includes('focus_session'), 'no focus_session for running', types.join(', '));
    const log = logsOf(runPanel)[0];
    check(Boolean(log), 'has a log widget');
    check(Boolean(log && log.proof !== 'none' && log.proofHint), 'the log takes proof, with a hint', `${log?.proof}: ${log?.proofHint}`);
    check(types.includes('streak') || types.includes('counter'), 'has a streak or a counter');
    check(Boolean(log && distanceField(log)), 'the log records a distance-like number', log?.fields.map((f) => f.key).join(', '));
    check(runPanel?.version === 1, 'version 1', String(runPanel?.version));
    const again = await api('POST', `/api/goals/${runId}/panel/design`, { userId });
    check(
      again.status === 200 && JSON.stringify(again.json?.goal?.panel) === JSON.stringify(runPanel),
      'designing again without an instruction keeps the panel (lazy design is idempotent)',
      `v${again.json?.goal?.panel?.version}`
    );
  }

  console.log('5. POST /panel/design for the thesis goal');
  let thesisPanel: PanelSpec | null = null;
  {
    const { status, json } = await api('POST', `/api/goals/${thesisId}/panel/design`, { userId });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    thesisPanel = json?.goal?.panel ?? null;
    printSpec('thesis design', thesisPanel);
    console.log(`    [thesis design json] ${JSON.stringify(thesisPanel)}`);
    const types = (thesisPanel?.widgets ?? []).map((w) => w.type);
    check(types.includes('focus_session'), 'thesis gets a focus_session', types.join(', '));
  }

  console.log('6. ownership and validation');
  {
    check((await api('POST', `/api/goals/${runId}/panel/design`, { userId: otherId })).status === 404, "design on someone else's goal -> 404");
    check((await api('POST', `/api/goals/${runId}/panel/design`, { userId: 'nope' })).status === 404, 'design for an unknown user -> 404');
    check((await api('POST', `/api/goals/nope/panel/design`, { userId })).status === 404, 'design for an unknown goal -> 404');
    check((await api('POST', `/api/goals/${runId}/panel/edit`, { userId, instruction: '' })).status === 400, 'edit with an empty instruction -> 400');
    check((await api('POST', `/api/goals/${runId}/panel/edit`, { userId, instruction: 'x'.repeat(301) })).status === 400, 'edit with 301 chars -> 400');
    check((await api('POST', `/api/goals/${runId}/panel/edit`, { userId: otherId, instruction: 'add a chart' })).status === 404, "edit on someone else's goal -> 404");
    check((await api('POST', `/api/goals/${runId}/panel/undo`, { userId: otherId })).status === 404, "undo on someone else's goal -> 404");
    check((await api('POST', `/api/goals/${runId}/panel/undo`, { userId })).status === 409, 'undo with nothing to undo -> 409');
  }

  console.log('7. POST /panel/edit "add a weekly chart of distance"');
  const logId = logsOf(runPanel)[0]?.id ?? '';
  const beforeEdit = runPanel;
  {
    const { status, json } = await api('POST', `/api/goals/${runId}/panel/edit`, { userId, instruction: 'add a weekly chart of distance' });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    console.log(`    [edit] change: ${JSON.stringify(json?.change)}`);
    const spec: PanelSpec | null = json?.goal?.panel ?? null;
    printSpec('running after edit', spec);
    const log = logsOf(spec).find((l) => l.id === logId);
    check(Boolean(log), 'the log kept its id', logId);
    // The designer may already have added a monthly chart; the edit must add (or turn one into) a weekly one.
    const charts = (spec?.widgets ?? []).filter((w) => w.type === 'chart' && w.source === logId);
    const chart = charts.find((w) => w.type === 'chart' && w.period === 'week') ?? charts[0];
    check(Boolean(chart), 'a chart sourced from the same log id');
    const field = chart && chart.type === 'chart' ? log?.fields.find((f) => f.key === chart.field) : undefined;
    check(Boolean(field && log && field === distanceField(log)), 'the chart plots the distance field', `${chart && chart.type === 'chart' ? chart.field : ''}`);
    check(chart?.type === 'chart' && chart.period === 'week', 'weekly');
    check(typeof json?.change === 'string' && json.change.length > 0 && json.change.length <= 120, 'change is one short line');
    check(spec?.version === (beforeEdit?.version ?? 0) + 1, 'version bumped', String(spec?.version));
  }

  console.log('8. POST /panel/undo restores the designed panel');
  {
    const { status, json } = await api('POST', `/api/goals/${runId}/panel/undo`, { userId });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    const spec: PanelSpec | null = json?.goal?.panel ?? null;
    check(
      JSON.stringify(spec?.widgets) === JSON.stringify(beforeEdit?.widgets),
      'widgets equal the pre-edit spec'
    );
    check((spec?.version ?? 0) > (beforeEdit?.version ?? 0) + 1, 'version still moves forward', String(spec?.version));
    runPanel = spec;
    check((await api('POST', `/api/goals/${runId}/panel/undo`, { userId })).status === 409, 'second undo -> 409 (stack empty)');
  }

  console.log('9. PATCH /panel/widgets/:id: move, remove');
  {
    const widgets = runPanel?.widgets ?? [];
    const last = widgets[widgets.length - 1];
    const moved = await api('PATCH', `/api/goals/${runId}/panel/widgets/${last?.id}`, { userId, op: { kind: 'move', to: 0 } });
    check(moved.status === 200 && moved.json?.goal?.panel?.widgets?.[0]?.id === last?.id, 'move last -> first');
    const victim = (moved.json?.goal?.panel?.widgets ?? []).find((w: Widget) => w.type !== 'log' && !('source' in w));
    if (victim) {
      const removed = await api('PATCH', `/api/goals/${runId}/panel/widgets/${victim.id}`, { userId, op: { kind: 'remove' } });
      check(
        removed.status === 200 && !(removed.json?.goal?.panel?.widgets ?? []).some((w: Widget) => w.id === victim.id),
        `remove ${victim.type}`
      );
      runPanel = removed.json?.goal?.panel ?? runPanel;
    } else check(true, 'no standalone widget to remove (skipped)');
    const undone = await api('POST', `/api/goals/${runId}/panel/undo`, { userId });
    check(undone.status === 200, 'manual edits are undoable');
    runPanel = undone.json?.goal?.panel ?? runPanel;
    check((await api('PATCH', `/api/goals/${runId}/panel/widgets/w_nope1234`, { userId, op: { kind: 'remove' } })).status === 404, 'unknown widget -> 404');
    check((await api('PATCH', `/api/goals/${runId}/panel/widgets/${logId}`, { userId, op: { kind: 'explode' } })).status === 400, 'unknown op -> 400');
    check((await api('PATCH', `/api/goals/${runId}/panel/widgets/${logId}`, { userId: otherId, op: { kind: 'remove' } })).status === 404, "someone else's goal -> 404");
  }

  console.log('10. PATCH toggle_item on a checklist (thesis panel saved through the model)');
  let thesisLogId = '';
  {
    const spec = sanitizePanel({
      profile: 'screen',
      summary: 'You write in focused sessions and log your words.',
      widgets: [
        { type: 'focus_session', title: 'Writing session', minutes: [25, 50] },
        { type: 'checklist', title: 'Before submission', items: ['Format references', 'Ask advisor for review'] },
        { type: 'log', ref: 'words', title: 'Words written', fields: [{ key: 'words', label: 'Words', kind: 'number', required: true }], proof: 'none' },
        { type: 'milestones', title: 'Chapters' },
      ],
    });
    const saved = await savePanel(userId, thesisId, spec);
    const goal = saved === 'conflict' ? null : saved;
    const list = goal?.panel?.widgets.find((w) => w.type === 'checklist');
    thesisLogId = logsOf(goal?.panel ?? null)[0]?.id ?? '';
    const itemId = list?.type === 'checklist' ? list.items[1].id : '';
    const r1 = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${list?.id}`, { userId, op: { kind: 'toggle_item', itemId } });
    const after = (r1.json?.goal?.panel?.widgets ?? []).find((w: Widget) => w.id === list?.id);
    check(r1.status === 200 && after?.items?.[1]?.done === true, 'item ticked');
    const r2 = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${list?.id}`, { userId, op: { kind: 'toggle_item', itemId } });
    const again = (r2.json?.goal?.panel?.widgets ?? []).find((w: Widget) => w.id === list?.id);
    check(r2.status === 200 && again?.items?.[1]?.done === false, 'item unticked');
    const r3 = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${thesisLogId}`, { userId, op: { kind: 'toggle_item', itemId } });
    check(r3.status === 400, 'toggle_item on a log -> 400');
    const r4 = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${list?.id}`, { userId, op: { kind: 'toggle_item', itemId: 'i_missing1' } });
    check(r4.status === 404, 'unknown item -> 404');
    // Remove a card, tick an item, undo the remove: the card is back and the tick stays.
    const ms = goal?.panel?.widgets.find((w) => w.type === 'milestones');
    const rm = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${ms?.id}`, { userId, op: { kind: 'remove' } });
    const firstItem = list?.type === 'checklist' ? list.items[0].id : '';
    const tick = await api('PATCH', `/api/goals/${thesisId}/panel/widgets/${list?.id}`, { userId, op: { kind: 'toggle_item', itemId: firstItem } });
    const undo = await api('POST', `/api/goals/${thesisId}/panel/undo`, { userId });
    const undoneList = (undo.json?.goal?.panel?.widgets ?? []).find((w: Widget) => w.id === list?.id);
    check(
      rm.status === 200 && tick.status === 200 && undo.status === 200 &&
        (undo.json?.goal?.panel?.widgets ?? []).some((w: Widget) => w.id === ms?.id) &&
        undoneList?.items?.[0]?.done === true,
      'undo brings the card back and keeps the tick made since'
    );
    // Quick moves in a row each build on the last one.
    const ids = (undo.json?.goal?.panel?.widgets ?? []).map((w: Widget) => w.id);
    const [m1, m2] = await Promise.all([
      api('PATCH', `/api/goals/${thesisId}/panel/widgets/${ids[0]}`, { userId, op: { kind: 'move', to: 3 } }),
      api('PATCH', `/api/goals/${thesisId}/panel/widgets/${ids[1]}`, { userId, op: { kind: 'move', to: 3 } }),
    ]);
    const final = (await api('GET', `/api/users/${userId}`)).json?.goals?.find((g: any) => g.id === thesisId)?.panel;
    const order = (final?.widgets ?? []).map((w: Widget) => w.id);
    check(
      m1.status === 200 && m2.status === 200 && order.length === ids.length && order.slice(2).sort().join() === [ids[0], ids[1]].sort().join(),
      'two parallel moves both land',
      order.map((id: string) => ids.indexOf(id)).join(',')
    );
    const e = await api('POST', `/api/goals/${thesisId}/entries`, { userId, widgetId: thesisLogId, values: { words: 850 } });
    check(e.status === 200 && e.json?.entry?.values?.words === 850, 'thesis entry logged (for the cascade check)');
  }

  console.log('11. POST /entries: valid and invalid values');
  const entryIds: string[] = [];
  const runLog = logsOf(runPanel).find((l) => l.id === logId) ?? logsOf(runPanel)[0];
  {
    const values = validValues(runLog);
    const { status, json } = await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: runLog.id, values, note: 'Easy <b>pace</b>' });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    const entry = json?.entry;
    if (entry?.id) entryIds.push(entry.id);
    check(entry?.proof === 'none' && entry?.widgetId === runLog.id, 'self-reported entry stored', JSON.stringify(entry?.values));
    check(entry?.note === 'Easy pace', 'note is plain text', JSON.stringify(entry?.note));
    const hasMinutes = runLog.fields.some((f) => f.kind === 'minutes');
    check(entry?.minutes === (hasMinutes ? 34 : 0), 'minutes from the first minutes field', String(entry?.minutes));
    check(json?.goal?.entries?.[0]?.id === entry?.id, 'goal.entries newest first');
    check(typeof json?.stats?.score === 'number' && 'points' in (json ?? {}), 'stats and points returned');

    const dist = distanceField(runLog);
    const bad: Array<[string, Record<string, unknown>]> = [['no values at all', {}]];
    if (dist) {
      bad.push(['a word for a number', { ...values, [dist.key]: 'far' }]);
      bad.push(['a negative number', { ...values, [dist.key]: -5 }]);
      bad.push(['a number over 100000', { ...values, [dist.key]: 100001 }]);
    }
    const rating = runLog.fields.find((f) => f.kind === 'rating');
    if (rating) bad.push(['rating 7', { ...values, [rating.key]: 7 }]);
    const text = runLog.fields.find((f) => f.kind === 'text');
    if (text) bad.push(['121-char text', { ...values, [text.key]: 'x'.repeat(121) }]);
    const required = runLog.fields.find((f) => f.required);
    if (required) {
      const { [required.key]: _omit, ...rest } = values;
      bad.push([`missing required ${required.key}`, rest]);
    }
    for (const [label, v] of bad) {
      const r = await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: runLog.id, values: v });
      check(r.status === 400, `${label} -> 400`, r.json?.error ?? String(r.status));
    }
    check((await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: 'w_nope1234', values })).status === 404, 'unknown widget -> 404');
    check((await api('POST', `/api/goals/${runId}/entries`, { userId: otherId, widgetId: runLog.id, values })).status === 404, "someone else's goal -> 404");
    check((await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: runLog.id, values, proof: Buffer.from('not an image at all').toString('base64') })).status === 400, 'non-image proof -> 400');
  }

  console.log('12. proof photos (vision judge)');
  {
    const before = (await api('GET', `/api/users/${userId}`)).json?.stats?.focusedMinutes ?? 0;
    const values = validValues(runLog, 6.2, 34);
    const strava = await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: runLog.id, values, proof: await stravaJpeg() });
    check(strava.status === 200, 'HTTP 200 with a Strava screenshot', strava.json?.error ?? '');
    const e1 = strava.json?.entry;
    if (e1?.id) entryIds.push(e1.id);
    console.log(`    [proof strava] ${e1?.proof}: ${JSON.stringify(e1?.proofReason)}`);
    check(e1?.proof === 'verified' || e1?.proof === 'unverified', 'Strava screenshot: verified or at least not rejected', e1?.proof);
    const after = strava.json?.stats?.focusedMinutes ?? 0;
    if (e1?.proof === 'verified' && e1?.minutes > 0) {
      check(after - before === e1.minutes, 'verified minutes count as focus (NSActivity source checkin)', `${before} -> ${after}`);
      const rows = await run(
        "MATCH (a: NSActivity {source: 'checkin'})-[:FOR]->(:NSGoal {id: $runId}) RETURN sum(a.minutes) AS m",
        { runId }
      );
      check(Number(rows[0]?.m ?? 0) === e1.minutes, 'one checkin activity for those minutes', String(rows[0]?.m));
    } else check(after === before, 'unverified entry does not count as focus', `${before} -> ${after}`);

    const groceries = await api('POST', `/api/goals/${runId}/entries`, { userId, widgetId: runLog.id, values, proof: await unrelatedJpeg() });
    check(groceries.status === 200, 'HTTP 200 with an unrelated photo', groceries.json?.error ?? '');
    const e2 = groceries.json?.entry;
    if (e2?.id) entryIds.push(e2.id);
    console.log(`    [proof groceries] ${e2?.proof}: ${JSON.stringify(e2?.proofReason)}`);
    check(e2?.proof === 'unverified' || e2?.proof === 'rejected', 'unrelated photo is not verified', e2?.proof);
    check((groceries.json?.stats?.focusedMinutes ?? 0) === after, 'and adds no focus minutes');
  }

  console.log('12b. verified check-ins count up to a daily cap (model.logCheckin)');
  {
    const usedRows = await run(
      `MATCH (:NSUser {id: $userId})-[:LOGGED]->(a: NSActivity {source: 'checkin'}) WHERE a.at >= $since RETURN coalesce(sum(a.minutes), 0) AS m`,
      { userId, since: new Date(Date.now() - 24 * 3_600_000).toISOString() }
    );
    const used = Number(usedRows[0]?.m ?? 0);
    const first = await logCheckin(userId, thesisId, 100, used + 150);
    const second = await logCheckin(userId, thesisId, 100, used + 150);
    const full = await logCheckin(userId, thesisId, 100, used + 150);
    check(first === 100 && second === 50 && full === 0, 'counts what is left under the cap, then nothing', `${first}, ${second}, ${full}`);
    const parallel = await Promise.all([logCheckin(userId, thesisId, 30, used + 170), logCheckin(userId, thesisId, 30, used + 170)]);
    check(parallel[0] + parallel[1] === 20, 'parallel check-ins cannot both fit under the cap', parallel.join(', '));
  }

  console.log('13. coach chat: "I ran 5 km in 31 minutes today"');
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId: runId,
      messages: [{ role: 'user', content: 'I ran 5 km in 31 minutes today' }],
    });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    console.log(`    [coach] reply: ${JSON.stringify(json?.reply)}`);
    const ev = (json?.events ?? []).find((e: any) => e.type === 'entry_logged');
    console.log(`    [coach] events: ${(json?.events ?? []).map((e: any) => e.type).join(', ') || '(none)'}`);
    check(Boolean(ev), 'entry_logged event', ev ? JSON.stringify(ev.entry?.values) : '');
    if (ev?.entry?.id) entryIds.push(ev.entry.id);
    const dist = distanceField(runLog);
    check(Boolean(ev && dist && ev.entry.values[dist.key] === 5), 'distance 5 logged', dist?.key);
    const minutesField = runLog.fields.find((f) => f.kind === 'minutes');
    if (minutesField) check(ev?.entry?.minutes === 31, '31 minutes logged', String(ev?.entry?.minutes));
    check(ev?.entry?.proof === 'none', 'self-reported (proof none)');
    check(!(json?.events ?? []).some((e: any) => e.type === 'focus_logged'), 'no duplicate focus_logged for the same run');
  }

  console.log('14. coach chat: asks for a panel change');
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId: runId,
      messages: [{ role: 'user', content: 'Can you add a habit grid of my runs for the last 4 weeks to my panel?' }],
    });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    const ev = (json?.events ?? []).find((e: any) => e.type === 'panel_updated');
    console.log(`    [coach] reply: ${JSON.stringify(json?.reply)} change: ${JSON.stringify(ev?.change)}`);
    check(Boolean(ev), 'panel_updated event');
    check(Boolean(ev?.goal?.panel?.widgets?.some((w: Widget) => w.type === 'habit_grid')), 'the panel now has a habit grid');
    check(Boolean(logsOf(ev?.goal?.panel ?? null).some((l) => l.id === runLog.id)), 'the log kept its id');
  }

  console.log('15. GET /api/users/:id returns panel and entries');
  {
    const { json } = await api('GET', `/api/users/${userId}`);
    const g = (json?.goals ?? []).find((x: any) => x.id === runId);
    check(Boolean(g?.panel?.widgets?.length), 'goal.panel present');
    const ats: string[] = (g?.entries ?? []).map((e: any) => e.at);
    check(ats.length === entryIds.length, 'all entries returned', `${ats.length} of ${entryIds.length}`);
    check(ats.every((at, i) => i === 0 || ats[i - 1] >= at), 'newest first');
  }

  console.log('16. DELETE /entries/:entryId');
  {
    const victim = entryIds[0];
    check((await api('DELETE', `/api/goals/${runId}/entries/${victim}`, { userId: otherId })).status === 404, "someone else's entry -> 404");
    const { status, json } = await api('DELETE', `/api/goals/${runId}/entries/${victim}`, { userId });
    check(status === 200 && !(json?.goal?.entries ?? []).some((e: any) => e.id === victim), 'entry deleted', json?.error ?? '');
    check(typeof json?.stats?.score === 'number', 'stats returned');
    check((await api('DELETE', `/api/goals/${runId}/entries/${victim}`, { userId })).status === 404, 'deleting it again -> 404');
  }

  console.log('16b. redesign in words keeps the entries on their log');
  {
    const before = (await api('GET', `/api/users/${userId}`)).json?.goals?.find((g: any) => g.id === runId);
    const { status, json } = await api('POST', `/api/goals/${runId}/panel/design`, {
      userId,
      instruction: 'Redesign it around my weekly distance, with a habit grid',
    });
    check(status === 200, 'HTTP 200', json?.error ?? '');
    const spec: PanelSpec | null = json?.goal?.panel ?? null;
    printSpec('running redesign', spec);
    const logIds = new Set(logsOf(spec).map((l) => l.id));
    const entries: any[] = json?.goal?.entries ?? [];
    check(
      entries.length === (before?.entries ?? []).length && entries.every((e) => logIds.has(e.widgetId)),
      'every entry still belongs to a log of the new panel',
      `${entries.length} entries, logs ${[...logIds].join(', ')}`
    );
  }

  console.log('17. DELETE the running goal: its entries go with it');
  {
    const remaining = entryIds.slice(1);
    check((await entryCount(remaining)) === remaining.length, 'entries exist before', String(remaining.length));
    const { status } = await api('DELETE', `/api/goals/${runId}`, { userId });
    check(status === 200, 'goal deleted');
    check((await entryCount(remaining)) === 0, 'no NSEntry of that goal left');
    check((await orphanEntries()) === 0, 'no orphan NSEntry anywhere');
    // What v1 leaves behind when it deletes a goal: an entry no goal holds.
    await run("CREATE (:NSEntry {id: 'zz-panels-orphan', widgetId: 'w_gone', at: $at, values: '{}'})", { at: new Date().toISOString() });
    const swept = await sweepOrphanEntries();
    check(swept >= 1 && (await orphanEntries()) === 0, 'the orphan sweep removes entries left without a goal', String(swept));
  }

  console.log('18. cleanup: delete the users (cascade includes entries), stop the server');
  {
    const thesisEntries = await run(
      'MATCH (:NSGoal {id: $thesisId})-[:HAS_ENTRY]->(e: NSEntry) RETURN collect(e.id) AS ids',
      { thesisId }
    );
    const ids = (thesisEntries[0]?.ids as string[]) ?? [];
    const removed = (await deleteNonSeededUsersByName(NAME)) + (await deleteNonSeededUsersByName(OTHER));
    check(removed === 2, 'both test users deleted', String(removed));
    check(ids.length === 1 && (await entryCount(ids)) === 0, 'the thesis entry went with the user', String(ids.length));
    check((await orphanEntries()) === 0, 'still no orphan NSEntry');
  }
  await stopApi(apiProc);
  apiProc = null;
  check(await portFree(PORT), `port ${PORT} free again`);

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all panels acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('panels test crashed:', err);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    await deleteNonSeededUsersByName(OTHER).catch(() => undefined);
    await stopApi(apiProc).catch(() => undefined);
    await close().catch(() => undefined);
    process.exit(1);
  });
