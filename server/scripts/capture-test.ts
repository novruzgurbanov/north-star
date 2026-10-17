/**
 * Acceptance checks for quick capture (BRIEF-capture.md) against a running server.
 * Start the server first (port 8790, points service unreachable on purpose):
 *   API_PORT=8790 POINTS_URL=http://localhost:9 npm start
 * Then run: npx tsx scripts/capture-test.ts
 *
 * Uses a throwaway user named "Zz Capture Test" and deletes it at the end.
 */
import { close } from '../src/db.js';
import { deleteNonSeededUsersByName } from '../src/model.js';

const NAME = 'Zz Capture Test';
const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8790';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

/** Brief requirement: print each reply and the suggestions. */
function show(label: string, reply: unknown, suggestions: unknown): void {
  console.log(`    [${label}] reply: ${JSON.stringify(reply)}`);
  console.log(`    [${label}] suggestions: ${JSON.stringify(suggestions)}`);
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

  console.log('2. "I want to learn to play guitar" -> brainstorm star born in the same response');
  let goalId = '';
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      messages: [{ role: 'user', content: 'I want to learn to play guitar' }],
    });
    check(status === 200, 'HTTP 200');
    const created = (json?.events ?? []).find((e: any) => e?.type === 'goal_created');
    check(Boolean(created), 'goal_created in the same response');
    const goal = created?.goal;
    check(goal?.status === 'brainstorm', 'goal status brainstorm', goal?.status);
    check(Array.isArray(goal?.milestones) && goal.milestones.length === 0, 'milestones: []', String(goal?.milestones?.length));
    check(
      typeof json?.reply === 'string' && json.reply.length > 0 && json.reply.length <= 400,
      'short reply',
      `${json?.reply?.length ?? 0} chars`
    );
    check(/brainstorm/i.test(String(json?.reply)), 'reply mentions Brainstorm', JSON.stringify(json?.reply));
    check(
      Array.isArray(json?.suggestions) && json.suggestions.length >= 2 && json.suggestions.length <= 3,
      '2-3 suggestions',
      JSON.stringify(json?.suggestions)
    );
    check(json?.understanding === 1, 'understanding = 1', String(json?.understanding));
    check(json?.phase === 'discovering', 'phase discovering');
    check(Array.isArray(goal?.missing) && goal.missing.length === 3, 'missing = success, steps, why', JSON.stringify(goal?.missing));
    goalId = goal?.id ?? '';
    check(Boolean(goalId), 'goal has an id', goalId);
    show('capture', json?.reply, json?.suggestions);
  }

  console.log('3. "hi" -> no goal, understanding 0');
  {
    const before = await api('GET', `/api/users/${userId}`);
    const goalsBefore = (before.json?.goals ?? []).length;
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check(status === 200, 'HTTP 200');
    check((json?.events ?? []).length === 0, 'no events', JSON.stringify((json?.events ?? []).map((e: any) => e.type)));
    check(json?.understanding === 0, 'understanding = 0', String(json?.understanding));
    check((json?.goals ?? []).length === goalsBefore, 'no new goal', `${goalsBefore} -> ${(json?.goals ?? []).length}`);
    show('small talk', json?.reply, json?.suggestions);
  }

  console.log('4. success description -> details_updated, success filled');
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId,
      messages: [{ role: 'user', content: "I'll know I made it when I can play Wonderwall for friends" }],
    });
    check(status === 200, 'HTTP 200');
    const details = (json?.events ?? []).find((e: any) => e?.type === 'details_updated');
    check(Boolean(details), 'details_updated event');
    check(
      typeof details?.goal?.successLooksLike === 'string' && details.goal.successLooksLike.length > 0,
      'successLooksLike set',
      JSON.stringify(details?.goal?.successLooksLike)
    );
    check(
      Array.isArray(details?.goal?.missing) && !details.goal.missing.includes('success'),
      'missing no longer contains success',
      JSON.stringify(details?.goal?.missing)
    );
    check(details?.goalId === goalId, 'details_updated carries the goalId');
    const fresh = (json?.goals ?? []).find((g: any) => g.id === goalId);
    check(Boolean(fresh?.successLooksLike), 'goals list has the new successLooksLike');
    check(fresh?.status === 'brainstorm', 'still brainstorm (no milestones yet)', fresh?.status);
    show('coach', json?.reply, json?.suggestions);
  }

  console.log('5. first steps -> milestones added, goal_ready, status ready');
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      goalId,
      messages: [{ role: 'user', content: "First I'll buy a guitar, learn 4 chords, then practice 15 min a day" }],
    });
    check(status === 200, 'HTTP 200');
    const added = (json?.events ?? []).filter((e: any) => e?.type === 'milestone_added');
    check(added.length >= 1, 'milestones added', String(added.length));
    check(
      (json?.events ?? []).some((e: any) => e?.type === 'goal_ready'),
      'goal_ready emitted',
      JSON.stringify((json?.events ?? []).map((e: any) => e.type))
    );
    const fresh = (json?.goals ?? []).find((g: any) => g.id === goalId);
    check(fresh?.status === 'ready', 'goal status ready', fresh?.status);
    check((fresh?.milestones ?? []).length >= 1, 'goal has milestones', String(fresh?.milestones?.length));
    check(
      Array.isArray(fresh?.missing) && fresh.missing.length === 1 && fresh.missing[0] === 'why',
      'missing = [why] only',
      JSON.stringify(fresh?.missing)
    );
    show('coach', json?.reply, json?.suggestions);
    console.log('    final goal:', JSON.stringify(fresh));
  }

  console.log('6. cleanup');
  {
    const removed = await deleteNonSeededUsersByName(NAME);
    check(removed >= 1, 'test user deleted', String(removed));
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all capture acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('capture test crashed:', err);
    await close().catch(() => undefined);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    process.exit(1);
  });
