/**
 * Acceptance checks for goal details + focus roast (BRIEF-details.md) against a running server.
 * Start the server first (port 8791, points service unreachable on purpose):
 *   API_PORT=8791 POINTS_URL=http://localhost:9 npm start
 * Then run: npx tsx scripts/details-test.ts
 *
 * Uses a throwaway user named "Zz Details Test" and deletes it at the end.
 * Screenshots are tiny JPEGs drawn locally with jimp (dev dependency).
 */
import { Jimp, JimpMime, loadFont } from 'jimp';
import { SANS_32_BLACK, SANS_32_WHITE, SANS_64_BLACK, SANS_64_WHITE } from 'jimp/fonts';
import { close } from '../src/db.js';
import { addMilestone, deleteNonSeededUsersByName, getGoal, updateGoalDetails } from '../src/model.js';

const NAME = 'Zz Details Test';
const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8791';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Draw a simple fake screenshot (solid background + big caption + sub lines) as base64 JPEG. */
async function screenshot(opts: {
  background: number;
  titleColor: number;
  title: string;
  subtitle?: string;
  lines?: string[];
}): Promise<string> {
  const img = new Jimp({ width: 800, height: 450, color: opts.background });
  const titleFont = await loadFont(opts.titleColor === 0xffffffff ? SANS_64_WHITE : SANS_64_BLACK);
  const bodyFont = await loadFont(opts.titleColor === 0xffffffff ? SANS_32_WHITE : SANS_32_BLACK);
  img.print({ font: titleFont, x: 30, y: 60, text: opts.title });
  if (opts.subtitle) img.print({ font: bodyFont, x: 30, y: 180, text: opts.subtitle });
  let y = 260;
  for (const line of opts.lines ?? []) {
    img.print({ font: bodyFont, x: 30, y, text: line });
    y += 50;
  }
  const buf = await img.getBuffer(JimpMime.jpeg);
  return buf.toString('base64');
}

async function main(): Promise<void> {
  console.log('0. cleanup leftover test users');
  {
    const removed = await deleteNonSeededUsersByName(NAME);
    check(true, 'leftovers removed', String(removed));
  }

  console.log('1. create the throwaway user');
  let userId = '';
  {
    const { status, json } = await api('POST', '/api/users', { name: NAME });
    check(status === 200 && json?.user?.id, 'POST /api/users', json?.user?.id ?? json?.error);
    userId = json?.user?.id ?? '';
  }

  console.log('2. capture the thesis goal -> goal_created + detail_added (motivation + distraction)');
  let goalId = '';
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      messages: [
        { role: 'user', content: 'I want to finish my thesis because I want to graduate, but YouTube keeps eating my evenings' },
      ],
    });
    check(status === 200, 'HTTP 200');
    const created = (json?.events ?? []).find((e: any) => e?.type === 'goal_created');
    check(Boolean(created), 'goal_created event');
    goalId = created?.goal?.id ?? '';
    check(Boolean(goalId), 'goal has an id', goalId);
    const added = (json?.events ?? []).filter((e: any) => e?.type === 'detail_added');
    check(added.length >= 2, 'detail_added events', `${added.length}: ${JSON.stringify(added.map((e: any) => e.detail))}`);
    const kinds = added.map((e: any) => e.detail?.kind);
    check(kinds.includes('motivation'), 'a motivation detail', JSON.stringify(added.map((e: any) => e.detail)));
    check(kinds.includes('distraction'), 'a distraction detail');
    check(
      added.every((e: any) => e.goalId === goalId && typeof e.detail?.id === 'string' && typeof e.detail?.text === 'string'),
      'detail_added events carry goalId + GoalDetail'
    );
    const fresh = (json?.goals ?? []).find((g: any) => g.id === goalId);
    check(
      Array.isArray(fresh?.details) && fresh.details.length === added.length,
      'returned goal carries the details',
      JSON.stringify(fresh?.details)
    );
    console.log(`    [capture] reply: ${JSON.stringify(json?.reply)}`);
  }

  console.log('3. coach: Overleaf mention -> detail_added with kind on_track (or action)');
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId,
      messages: [{ role: 'user', content: "When I'm working I'm in Overleaf writing chapter 3" }],
    });
    check(status === 200, 'HTTP 200');
    const added = (json?.events ?? []).filter((e: any) => e?.type === 'detail_added');
    check(added.length >= 1, 'detail_added event', JSON.stringify(added.map((e: any) => e.detail)));
    const ok = added.some((e: any) => e.detail?.kind === 'on_track' || e.detail?.kind === 'action');
    check(ok, 'detail kind is on_track or action', JSON.stringify(added.map((e: any) => e.detail?.kind)));
    console.log(`    [coach] reply: ${JSON.stringify(json?.reply)}`);
  }

  console.log('3b. coach: a personal why -> motivation detail fills the still-empty why');
  {
    const before = await getGoal(userId, goalId);
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId,
      messages: [{ role: 'user', content: "Honestly, this matters because I'm the first in my family to get a degree" }],
    });
    check(status === 200, 'HTTP 200');
    const motivation = (json?.events ?? []).filter(
      (e: any) => e?.type === 'detail_added' && e?.detail?.kind === 'motivation'
    );
    console.log(
      `    [coach why] detail_added: ${JSON.stringify(motivation.map((e: any) => e.detail?.text))} reply: ${JSON.stringify(json?.reply)}`
    );
    const after = await getGoal(userId, goalId);
    check(
      Boolean(after?.why?.trim()),
      'empty why got filled from the recorded motivation',
      JSON.stringify(after?.why ?? '') + (before?.why?.trim() ? ' (was already set)' : ' (was empty)')
    );
  }

  console.log('4. mark the goal ready via the model (success + one milestone)');
  {
    const withSuccess = await updateGoalDetails(userId, goalId, {
      successLooksLike: 'I hand in the full draft and my advisor approves it',
    });
    check(withSuccess?.successLooksLike.includes('advisor') === true, 'successLooksLike set via model');
    const milestone = await addMilestone(goalId, 'Draft chapter 3');
    check(milestone !== null, 'milestone added via model', milestone?.title);
    const goal = await getGoal(userId, goalId);
    check(goal?.status === 'ready', 'goal is ready', goal?.status);
    check((goal?.details.length ?? 0) >= 3, 'goal keeps its details', String(goal?.details.length));
  }

  console.log('5. focus check #1: Overleaf screenshot -> on_track, no roast');
  let onTrackVerdict: any = null;
  {
    const screen = await screenshot({
      background: 0xf7f7f7ff,
      titleColor: 0x111111ff,
      title: 'Overleaf - thesis.tex - Chapter 3: Methods',
      subtitle: '3.2 Evaluation of the proposed method',
      lines: [
        'We evaluate the approach on three datasets and compare',
        'the results with the baseline described in chapter 2.',
        'Table 3.1 shows the accuracy of each variant.',
      ],
    });
    const { status, json } = await api('POST', '/api/focus/check', {
      userId,
      goalId,
      screen,
      sinceSeconds: 60,
    });
    check(status === 200, 'HTTP 200');
    check(json?.verdict === 'on_track', 'verdict on_track', `${json?.verdict} (${json?.reason})`);
    check(json?.roast === '', 'no roast when on_track', JSON.stringify(json?.roast));
    check(typeof json?.countedSeconds === 'number', 'response has countedSeconds');
    onTrackVerdict = json;
  }

  console.log('6. focus check #2: YouTube screenshot -> off_track with a PG roast');
  let offTrackVerdict: any = null;
  {
    const screen = await screenshot({
      background: 0x181818ff,
      titleColor: 0xffffffff,
      title: 'YouTube - Funny cat compilation #47',
      subtitle: 'Funny cat compilation #47 - try not to laugh',
      lines: ['Up next: Funny cat compilation #48', '4.2M views - 2 hours ago', 'Autoplay is on'],
    });
    const { status, json } = await api('POST', '/api/focus/check', {
      userId,
      goalId,
      screen,
      sinceSeconds: 60,
    });
    check(status === 200, 'HTTP 200');
    check(json?.verdict === 'off_track', 'verdict off_track', `${json?.verdict} (${json?.reason})`);
    check(typeof json?.roast === 'string' && json.roast.trim().length > 0, 'roast is non-empty', JSON.stringify(json?.roast));
    check((json?.roast ?? '').length <= 200, 'roast max 200 chars');
    check(!/\b(fuck|shit|bitch|asshole|bastard)\b/i.test(json?.roast ?? ''), 'roast is PG', JSON.stringify(json?.roast));
    check(typeof json?.nudge === 'string' && json.nudge.length > 0, 'nudge present when off_track', JSON.stringify(json?.nudge));
    offTrackVerdict = json;
  }

  console.log('');
  console.log('VERDICT 1 (Overleaf):  ' + JSON.stringify(onTrackVerdict));
  console.log('VERDICT 2 (YouTube):   ' + JSON.stringify(offTrackVerdict));

  console.log('7. cleanup');
  {
    const removed = await deleteNonSeededUsersByName(NAME);
    check(removed >= 1, 'test user deleted', String(removed));
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all details acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('details test crashed:', err);
    await close().catch(() => undefined);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    process.exit(1);
  });
