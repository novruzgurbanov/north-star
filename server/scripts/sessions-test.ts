/**
 * Acceptance checks for focus sessions (BRIEF-sessions.md) against a running server.
 * Start the server first (port 8793, points service unreachable on purpose):
 *   API_PORT=8793 POINTS_URL=http://localhost:9 npm start
 * Then run: PORT=8793 npx tsx scripts/sessions-test.ts
 *
 * Uses a throwaway user named "Zz Session Test" (plus "Zz Session Other" for the
 * not-their-goal 404 checks) and deletes both at the end.
 * The ready goal with 2 milestones is created through the model (src/model.ts).
 */
import { close } from '../src/db.js';
import { createGoal, deleteNonSeededUsersByName, getGoal, updateGoalDetails } from '../src/model.js';

const NAME = 'Zz Session Test';
const OTHER = 'Zz Session Other';
const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8793';

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

async function main(): Promise<void> {
  console.log('0. cleanup leftover test users');
  {
    const a = await deleteNonSeededUsersByName(NAME);
    const b = await deleteNonSeededUsersByName(OTHER);
    check(true, 'leftovers removed', `${a} + ${b}`);
  }

  console.log('1. create the throwaway user');
  let userId = '';
  {
    const { status, json } = await api('POST', '/api/users', { name: NAME });
    check(status === 200 && json?.user?.id, 'POST /api/users', json?.user?.id ?? json?.error);
    userId = json?.user?.id ?? '';
  }

  console.log('2. ready goal with 2 milestones created through the model');
  let goalId = '';
  let ms1 = '';
  let ms2 = '';
  {
    const goal = await createGoal(userId, {
      title: 'Finish my thesis',
      why: 'I want to graduate this year',
      successLooksLike: '',
      deadline: null,
      milestones: ['Draft chapter 3 outline', 'Send the draft to my advisor'],
    });
    check(goal !== null && goal.milestones.length === 2, 'goal created with 2 milestones', goal?.id);
    goalId = goal?.id ?? '';
    ms1 = goal?.milestones[0]?.id ?? '';
    ms2 = goal?.milestones[1]?.id ?? '';
    check(ms1 !== '' && ms2 !== '', 'milestone ids present', `${ms1}, ${ms2}`);
    const ready = await updateGoalDetails(userId, goalId, {
      successLooksLike: 'My advisor approves the full draft',
    });
    check(ready?.status === 'ready', 'goal is ready', ready?.status);
  }

  console.log('3. POST /api/goals/:goalId/next-step');
  {
    const { status, json } = await api('POST', `/api/goals/${goalId}/next-step`, { userId });
    check(status === 200, 'HTTP 200', JSON.stringify(json?.error ?? ''));
    const task = String(json?.task ?? '');
    console.log(
      `    [next-step] task: ${JSON.stringify(task)} minutes: ${json?.minutes} why: ${JSON.stringify(json?.why)} milestoneId: ${json?.milestoneId}`
    );
    check(task.trim().length > 0, 'sensible task returned', task);
    check([15, 25, 50, 90].includes(json?.minutes), 'minutes is 15 | 25 | 50 | 90', String(json?.minutes));
    check(typeof json?.why === 'string', 'why present', JSON.stringify(json?.why));
    check(
      json?.milestoneId === null || json?.milestoneId === ms1 || json?.milestoneId === ms2,
      'milestoneId belongs to the goal or null',
      String(json?.milestoneId)
    );
  }

  console.log('4. 404s + validation');
  {
    const noUser = await api('POST', `/api/goals/${goalId}/next-step`, { userId: 'nope' });
    check(noUser.status === 404, 'next-step unknown user -> 404');

    const other = await api('POST', '/api/users', { name: OTHER });
    const otherId = other.json?.user?.id ?? '';
    check(otherId !== '', 'second user created', otherId);
    const notTheirsNext = await api('POST', `/api/goals/${goalId}/next-step`, { userId: otherId });
    check(notTheirsNext.status === 404, "next-step on someone else's goal -> 404");
    const notTheirsRecap = await api('POST', '/api/sessions/recap', {
      userId: otherId,
      goalId,
      task: 'Draft chapter 3 outline',
      plannedMinutes: 25,
      activeSeconds: 0,
      verifiedSeconds: 0,
      completed: false,
      checks: [],
    });
    check(notTheirsRecap.status === 404, "recap on someone else's goal -> 404");

    const badMinutes = await api('POST', '/api/sessions/recap', {
      userId,
      goalId,
      task: 'Write',
      plannedMinutes: 4,
      activeSeconds: 0,
      verifiedSeconds: 0,
      completed: false,
      checks: [],
    });
    check(badMinutes.status === 400, 'recap plannedMinutes 4 -> 400');
    const badTask = await api('POST', '/api/sessions/recap', {
      userId,
      goalId,
      task: '',
      plannedMinutes: 25,
      activeSeconds: 0,
      verifiedSeconds: 0,
      completed: false,
      checks: [],
    });
    check(badTask.status === 400, 'recap empty task -> 400');
    const manyChecks = Array.from({ length: 201 }, (_, i) => ({
      at: new Date(Date.now() + i * 1000).toISOString(),
      verdict: 'on_track',
      reason: 'writing in Overleaf',
    }));
    const badChecks = await api('POST', '/api/sessions/recap', {
      userId,
      goalId,
      task: 'Write',
      plannedMinutes: 25,
      activeSeconds: 0,
      verifiedSeconds: 0,
      completed: false,
      checks: manyChecks,
    });
    check(badChecks.status === 400, 'recap 201 checks -> 400');
    const longReason = await api('POST', '/api/sessions/recap', {
      userId,
      goalId,
      task: 'Write',
      plannedMinutes: 25,
      activeSeconds: 0,
      verifiedSeconds: 0,
      completed: false,
      checks: [{ at: new Date().toISOString(), verdict: 'on_track', reason: 'x'.repeat(201) }],
    });
    check(longReason.status === 400, 'recap 201-char reason -> 400');
  }

  console.log('5. POST /api/sessions/recap (25 planned, 1500 active, 1260 verified, 2 off_track)');
  let sessionId = '';
  {
    const start = Date.now() - 22 * 60 * 1000;
    const checks = [
      { at: new Date(start + 8 * 60 * 1000).toISOString(), verdict: 'off_track', reason: 'watching YouTube' },
      { at: new Date(start + 18 * 60 * 1000).toISOString(), verdict: 'off_track', reason: 'watching YouTube' },
    ];
    const { status, json } = await api('POST', '/api/sessions/recap', {
      userId,
      goalId,
      task: 'Draft chapter 3 outline', // matches the first milestone, verified 21/25 min = 84%
      plannedMinutes: 25,
      activeSeconds: 1500,
      verifiedSeconds: 1260,
      completed: true,
      checks,
    });
    check(status === 200, 'HTTP 200', JSON.stringify(json?.error ?? ''));
    console.log(`    [recap] headline:  ${JSON.stringify(json?.headline)}`);
    console.log(`    [recap] summary:   ${JSON.stringify(json?.summary)}`);
    console.log(`    [recap] driftNote: ${JSON.stringify(json?.driftNote)}`);
    console.log(`    [recap] next:      ${JSON.stringify(json?.next)}`);
    console.log(
      `    [recap] suggestMilestoneId: ${JSON.stringify(json?.suggestMilestoneId)} (first milestone: ${ms1})`
    );
    const s = json?.session ?? {};
    sessionId = String(s.id ?? '');
    check(sessionId.length > 0, 'session saved with id', sessionId);
    check(
      s.task === 'Draft chapter 3 outline' &&
        s.plannedMinutes === 25 &&
        s.activeSeconds === 1500 &&
        s.verifiedSeconds === 1260,
      'session carries the numbers'
    );
    check(s.drifts === 2, 'drifts = the 2 off_track checks', String(s.drifts));
    check(typeof s.headline === 'string' && s.headline.length > 0, 'headline non-empty', JSON.stringify(s.headline));
    check(
      typeof s.endedAt === 'string' && !Number.isNaN(new Date(s.endedAt).getTime()),
      'endedAt is a date',
      s.endedAt
    );
    check(json?.headline === s.headline, 'response headline matches the saved session');
    check(typeof json?.summary === 'string' && json.summary.length > 0, 'summary non-empty', JSON.stringify(json?.summary));
    check(json?.driftNote !== '', 'driftNote present for off_track checks', JSON.stringify(json?.driftNote));
    check(json?.next?.task?.trim().length > 0, 'next.task non-empty', JSON.stringify(json?.next?.task));
    check([15, 25, 50, 90].includes(json?.next?.minutes), 'next.minutes is 15 | 25 | 50 | 90', String(json?.next?.minutes));
    check(json?.suggestMilestoneId === ms1, 'suggestMilestoneId is the first (matching, undone) milestone', String(json?.suggestMilestoneId));
  }

  console.log('6. GET /api/users/:id shows the session on the goal');
  {
    const { status, json } = await api('GET', `/api/users/${userId}`);
    check(status === 200, 'HTTP 200');
    const goal = (json?.goals ?? []).find((g: any) => g.id === goalId);
    check(Boolean(goal), 'goal returned');
    const sessions = goal?.sessions ?? [];
    check(Array.isArray(sessions) && sessions.length === 1, 'goal.sessions has the session', String(sessions.length));
    check(sessions[0]?.id === sessionId, 'session id matches (newest first)', sessions[0]?.id);
    check(
      sessions[0]?.task === 'Draft chapter 3 outline' && sessions[0]?.drifts === 2 && sessions[0]?.verifiedSeconds === 1260,
      'session fields intact on the goal',
      JSON.stringify(sessions[0])
    );
  }

  console.log('7. cleanup');
  {
    const a = await deleteNonSeededUsersByName(NAME);
    const b = await deleteNonSeededUsersByName(OTHER);
    check(a >= 1 && b >= 1, 'both test users deleted', `${a} + ${b}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all sessions acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('sessions test crashed:', err);
    await close().catch(() => undefined);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    await deleteNonSeededUsersByName(OTHER).catch(() => undefined);
    process.exit(1);
  });
