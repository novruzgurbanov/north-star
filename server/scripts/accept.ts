/**
 * Acceptance checks against a running v2 server on :8887 (start it with `npm start`).
 * Exercises every endpoint end-to-end, including a real multi-turn discover
 * conversation that births a goal, then deletes all test data it created.
 *
 * Run: npx tsx scripts/accept.ts
 */
import { close } from '../src/db.js';
import { deleteNonSeededUsersByName } from '../src/model.js';

const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8887';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
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

async function main(): Promise<void> {
  console.log('0. cleanup leftover test users (from earlier manual curls)');
  {
    const t = await deleteNonSeededUsersByName('Test');
    const n = await deleteNonSeededUsersByName('Nobody');
    check(true, 'leftovers removed', `${t} Test, ${n} Nobody`);
  }

  console.log('1. health');
  {
    const { status, json } = await api('GET', '/api/health');
    check(status === 200 && json?.ok === true, 'GET /api/health returns ok');
    check(json?.neo4j === true, 'neo4j is up');
    check(json?.llm === true, 'llm key configured');
  }

  console.log('2. leaderboard has 9 seeded rows sorted by score');
  {
    const { status, json } = await api('GET', '/api/leaderboard');
    const rows: any[] = json?.rows ?? [];
    check(status === 200 && rows.length === 9, '9 rows', `got ${rows.length}`);
    check(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), 'sorted by score desc');
    check(rows[0].rank === 1, 'rank starts at 1', `top: ${rows[0]?.name} ${rows[0]?.score}`);
    const scores = rows.map((r) => r.score);
    check(Math.min(...scores) >= 80 && Math.max(...scores) <= 1400, 'scores span ~80..1400');
    const streaks = rows.map((r) => r.streak);
    check(Math.min(...streaks) === 0 && Math.max(...streaks) === 9, 'streaks span 0..9');
  }

  console.log('3. cosmos returns users with goals');
  {
    const { status, json } = await api('GET', '/api/cosmos');
    const users: any[] = json?.users ?? [];
    check(status === 200 && users.length === 9, '9 users');
    check(users.every((u) => Array.isArray(u.goals) && u.goals.length >= 1), 'every user has goals');
    const aiko = users.find((u) => u.name === 'Aiko');
    check(aiko && aiko.goals.length === 2, 'Aiko has 2 goals');
    const kenji = users.find((u) => u.name === 'Kenji');
    const g = kenji?.goals?.[0];
    check(
      g &&
        g.brightness === 0.9 &&
        g.milestones.length === 6 &&
        g.milestones[0].brightness === 1 &&
        g.milestones[5].brightness === 0.18,
      'Kenji goal brightness math (0.25 + 0.6*5/6 + 0.15 = 0.9) and milestone brightness'
    );
  }

  console.log('4. create Test user (upsert, case-insensitive)');
  let userId = '';
  {
    const { status, json } = await api('POST', '/api/users', { name: 'Test' });
    check(status === 200 && json?.user?.id, 'POST /api/users returns user', json?.user?.id);
    check(json?.user?.seeded === false, 'non-seeded');
    check(typeof json?.user?.color === 'string', 'color assigned', json?.user?.color);
    userId = json?.user?.id ?? '';
    const again = await api('POST', '/api/users', { name: 'tEsT' });
    check(again.json?.user?.id === userId, 'case-insensitive upsert returns the same user');
    const bad = await api('POST', '/api/users', { name: '' });
    check(bad.status === 400 && bad.json?.error, 'empty name -> 400 {error}');
  }

  console.log('5. first chat turn is a question with understanding < 0.5');
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const scriptedAnswers = [
    'I really want to learn to play the guitar this year.',
    'Because my friends and I always talk about forming a band someday, and I do not want to be the one who cannot play.',
    'Success is playing three full songs with the group at our summer barbecue.',
    'By June 21st, the day of the barbecue.',
    'Right now I only know a couple of open chords. My fingertips hurt quickly and I practice maybe ten minutes a week.',
    'That is honestly everything there is to know. Please go ahead and create my goal.',
  ];
  {
    history.push({ role: 'user', content: scriptedAnswers[0] });
    const { status, json } = await api('POST', '/api/chat', { userId, messages: history });
    check(status === 200 && typeof json?.reply === 'string' && json.reply.length > 0, 'returns a reply');
    check(
      typeof json?.understanding === 'number' && json.understanding >= 0 && json.understanding < 0.5,
      'understanding < 0.5',
      String(json?.understanding)
    );
    check(json?.phase === 'discovering', 'phase discovering');
    check(Array.isArray(json?.events) && json.events.length === 0, 'no events yet');
    history.push({ role: 'assistant', content: json.reply });
  }

  console.log('6. multi-turn discover conversation births a goal');
  let goal: any = null;
  {
    for (let turn = 1; turn < scriptedAnswers.length && !goal; turn++) {
      history.push({ role: 'user', content: scriptedAnswers[turn] });
      const { status, json } = await api('POST', '/api/chat', { userId, messages: history });
      check(status === 200 && typeof json?.reply === 'string', `turn ${turn + 1}: reply ok`);
      history.push({ role: 'assistant', content: json.reply });
      const created = (json?.events ?? []).find((e: any) => e?.type === 'goal_created');
      if (created) {
        goal = created.goal;
        check(json.understanding === 1, 'understanding = 1 once the goal is born');
        check((json?.goals ?? []).length === 1, 'goals list has the new goal');
      }
    }
    check(goal !== null, 'goal_created event with a full Goal');
    if (goal) {
      check(typeof goal.id === 'string' && goal.id.length > 0, 'goal has an id');
      check(
        typeof goal.title === 'string' &&
          typeof goal.why === 'string' &&
          typeof goal.successLooksLike === 'string',
        'goal title/why/successLooksLike present',
        goal.title
      );
      check(goal.brightness === 0.25, 'fresh goal brightness is 0.25', String(goal.brightness));
      check(Array.isArray(goal.milestones) && goal.milestones.length >= 1, 'goal has milestones', `${goal.milestones.length}`);
      check(
        goal.milestones.every((m: any, i: number) => m.order === i) &&
          goal.milestones.every((m: any) => m.done === false && m.brightness === 0.18),
        'milestones sorted by order, undone, brightness 0.18'
      );
    }
  }

  console.log('7. activity raises the score once the user has a goal');
  let statsBefore: any;
  {
    const before = await api('GET', `/api/users/${userId}`);
    statsBefore = before.json?.stats;
    check(before.status === 200 && before.json?.user?.id === userId, 'GET /api/users/:id');
    check(Array.isArray(before.json?.goals) && before.json?.goals.length === 1, 'goals included');

    const act = await api('POST', '/api/activity', { userId, onTask: true, minutes: 30 });
    check(act.status === 200 && act.json?.goal?.id === goal?.id, 'POST /api/activity returns the goal');
    const after = act.json?.stats;
    check(
      after?.focusedMinutes === 30 + (statsBefore?.focusedMinutes ?? 0),
      'on-task minutes counted',
      `focusedMinutes ${statsBefore?.focusedMinutes} -> ${after?.focusedMinutes}`
    );
    check(after.score > statsBefore.score, 'score raised', `${statsBefore.score} -> ${after.score}`);
    statsBefore = after;

    const off = await api('POST', '/api/activity', { userId, onTask: false, minutes: 15 });
    check(off.status === 200, 'off-task activity is stored');
    check(off.json?.stats?.score === statsBefore.score, 'off-task minutes earn nothing');

    // activity with no goalId falls back to the most recent goal
    const fb = await api('POST', '/api/activity', { userId, onTask: true, minutes: 10 });
    check(fb.status === 200 && fb.json?.goal?.id === goal?.id, 'missing goalId -> most recent goal');
  }

  console.log('8. milestone toggle');
  {
    const fresh = await api('GET', `/api/users/${userId}`);
    const undone = fresh.json?.goals?.[0]?.milestones?.find((m: any) => !m.done);
    const t = await api('POST', `/api/milestones/${undone.id}/toggle`, { userId });
    check(t.status === 200 && t.json?.goal?.id === goal.id, 'toggle returns the parent goal');
    check(t.json?.goal?.milestones?.find((m: any) => m.id === undone.id)?.done === true, 'milestone now done');
    check(t.json?.stats?.milestonesDone === 1, 'milestonesDone counted', String(t.json?.stats?.milestonesDone));
    const back = await api('POST', `/api/milestones/${undone.id}/toggle`, { userId });
    check(
      back.json?.goal?.milestones?.find((m: any) => m.id === undone.id)?.done === false,
      'toggle back works'
    );
    const badUser = await api('POST', `/api/milestones/${undone.id}/toggle`, { userId: 'does-not-exist' });
    check(badUser.status === 404 && badUser.json?.error, 'toggle with unknown user -> 404 {error}');
  }

  console.log('9. coaching phase');
  {
    history.push({ role: 'user', content: 'I practiced chord changes for 40 minutes today and finished the first milestone!' });
    const { status, json } = await api('POST', '/api/chat', { userId, goalId: goal.id, messages: history });
    check(status === 200 && typeof json?.reply === 'string' && json.reply.length > 0, 'coaching reply ok');
    check(json?.phase === 'coaching', 'phase coaching');
    check(json?.understanding === 1, 'understanding always 1 in coaching');
    check(Array.isArray(json?.events), 'events array present');
    const types = (json?.events ?? []).map((e: any) => e.type);
    check(
      types.every((t: string) => ['milestone_done', 'milestone_added', 'focus_logged'].includes(t)),
      'all events are valid AgentEvents',
      types.join(',') || 'none'
    );
    console.log('    (coach reply:', JSON.stringify(json.reply).slice(0, 140) + '...)');
  }

  console.log('10. error handling');
  {
    const noUser = await api('POST', '/api/chat', { userId: 'nope', messages: [{ role: 'user', content: 'hi' }] });
    check(noUser.status === 404 && noUser.json?.error, 'chat with unknown user -> 404 {error}');

    const nobody = await api('POST', '/api/users', { name: 'Nobody' });
    const nobodyId = nobody.json?.user?.id;
    const noGoal = await api('POST', '/api/activity', { userId: nobodyId, onTask: true, minutes: 5 });
    check(noGoal.status === 400 && noGoal.json?.error, 'activity without any goal -> 400 {error}');

    const badBody = await api('POST', '/api/chat', { userId, messages: [] });
    check(badBody.status === 400 && badBody.json?.error, 'empty messages -> 400 {error}');

    const badJson = await fetch(BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    check(badJson.status === 400, 'malformed JSON -> 400');

    const notFound = await api('GET', '/api/nope');
    check(notFound.status === 404 && notFound.json?.error === 'not found', 'unknown route -> 404 {error}');
  }

  console.log('11. cleanup test data');
  {
    const removedTest = await deleteNonSeededUsersByName('Test');
    const removedNobody = await deleteNonSeededUsersByName('Nobody');
    check(removedTest >= 1 && removedNobody >= 1, 'Test and Nobody users deleted', `${removedTest}+${removedNobody}`);
    const lb = await api('GET', '/api/leaderboard');
    check((lb.json?.rows ?? []).length === 9, 'leaderboard back to 9 seeded rows');
    const remaining = await api('GET', `/api/users/${userId}`);
    check(remaining.status === 404, 'Test user is gone');
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('acceptance run crashed:', err);
    await close().catch(() => undefined);
    process.exit(1);
  });
