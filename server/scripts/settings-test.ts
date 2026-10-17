/**
 * Acceptance checks for per-user settings (BRIEF-settings.md) against a running server.
 * Start the server first (port 8792, points service unreachable on purpose):
 *   API_PORT=8792 POINTS_URL=http://localhost:9 npm start
 * Then run: npx tsx scripts/settings-test.ts
 *
 * Uses a throwaway user named "Zz Settings Test" and deletes it at the end.
 * The screenshot is a tiny JPEG drawn locally with jimp (dev dependency).
 */
import { Jimp, JimpMime, loadFont } from 'jimp';
import { SANS_32_WHITE, SANS_64_WHITE } from 'jimp/fonts';
import { close, run } from '../src/db.js';
import { deleteNonSeededUsersByName, getSettings } from '../src/model.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/types.js';

const NAME = 'Zz Settings Test';
const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8792';

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

function sameSettings(a: any, b: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).every((k) => a?.[k] === b[k]);
}

/** Draw a fake YouTube screenshot (dark background, white text) as base64 JPEG. */
async function youtubeScreenshot(): Promise<string> {
  const img = new Jimp({ width: 800, height: 450, color: 0x181818ff });
  const titleFont = await loadFont(SANS_64_WHITE);
  const bodyFont = await loadFont(SANS_32_WHITE);
  img.print({ font: titleFont, x: 30, y: 60, text: 'YouTube - Funny cat compilation #47' });
  img.print({ font: bodyFont, x: 30, y: 180, text: 'Funny cat compilation #47 - try not to laugh' });
  img.print({ font: bodyFont, x: 30, y: 260, text: 'Up next: Funny cat compilation #48' });
  img.print({ font: bodyFont, x: 30, y: 320, text: '4.2M views - 2 hours ago - Autoplay is on' });
  const buf = await img.getBuffer(JimpMime.jpeg);
  return buf.toString('base64');
}

async function focusCheck(userId: string, goalId: string, screen: string): Promise<{ status: number; json: any }> {
  return api('POST', '/api/focus/check', { userId, goalId, screen, sinceSeconds: 60 });
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

  console.log('2. GET settings -> defaults (also on GET /api/users/:id)');
  {
    const { status, json } = await api('GET', `/api/users/${userId}/settings`);
    check(status === 200, 'HTTP 200');
    check(sameSettings(json?.settings, DEFAULT_SETTINGS), 'settings are the defaults', JSON.stringify(json?.settings));
    const userRes = await api('GET', `/api/users/${userId}`);
    check(sameSettings(userRes.json?.settings, DEFAULT_SETTINGS), 'GET /api/users/:id carries settings too');
  }

  console.log('3. PUT partial -> merged, saved, full settings returned');
  {
    const { status, json } = await api('PUT', `/api/users/${userId}/settings`, {
      helpfulness: 'quiet',
      roast: 'off',
      checkSeconds: 45,
    });
    check(status === 200, 'HTTP 200');
    const expected: Settings = { ...DEFAULT_SETTINGS, helpfulness: 'quiet', roast: 'off', checkSeconds: 45 };
    check(sameSettings(json?.settings, expected), 'merged settings returned', JSON.stringify(json?.settings));
    const again = await api('GET', `/api/users/${userId}/settings`);
    check(sameSettings(again.json?.settings, expected), 'settings persisted');
  }

  console.log('4. PUT {checkSeconds: 5} -> 400, settings unchanged');
  {
    const { status, json } = await api('PUT', `/api/users/${userId}/settings`, { checkSeconds: 5 });
    check(status === 400, 'HTTP 400', `${status} ${JSON.stringify(json?.error ?? '')}`);
    const again = await api('GET', `/api/users/${userId}/settings`);
    check(again.json?.settings?.checkSeconds === 45, 'checkSeconds still 45', JSON.stringify(again.json?.settings));
  }

  console.log('5. PUT unknown key -> dropped, settings unchanged');
  {
    const { status, json } = await api('PUT', `/api/users/${userId}/settings`, { nope: 'x' });
    check(status === 200, 'HTTP 200');
    check(
      json?.settings?.nope === undefined && json?.settings?.helpfulness === 'quiet',
      'unknown key dropped',
      JSON.stringify(json?.settings)
    );
  }

  console.log('6. capture with helpfulness quiet -> reply without a question mark');
  let goalId = '';
  {
    const { status, json } = await api('POST', '/api/chat', {
      userId,
      messages: [{ role: 'user', content: 'I want to finish my thesis draft because I want to graduate' }],
    });
    check(status === 200, 'HTTP 200');
    const created = (json?.events ?? []).find((e: any) => e?.type === 'goal_created');
    goalId = created?.goal?.id ?? '';
    check(Boolean(goalId), 'goal_created event', goalId);
    console.log(`    [capture quiet] reply: ${JSON.stringify(json?.reply)}`);
    check(typeof json?.reply === 'string' && !json.reply.includes('?'), 'quiet reply asks no question');
  }

  const screen = await youtubeScreenshot();

  console.log("7. focus check with roast 'off' -> roast forced \"\" (strictness still normal)");
  {
    const { status, json } = await focusCheck(userId, goalId, screen);
    check(status === 200, 'HTTP 200');
    check(json?.verdict === 'off_track', 'verdict off_track', `${json?.verdict} (${json?.reason})`);
    check(json?.roast === '', 'roast forced ""', JSON.stringify(json?.roast));
    check(json?.notifyAbove === 0.7, 'notifyAbove matches strictness normal (0.7)', JSON.stringify(json?.notifyAbove));
    console.log(`    [roast off]     ${JSON.stringify(json?.roast)}`);
  }

  console.log("8. PUT {roast: 'spicy', strictness: 'strict'} -> non-empty roast, notifyAbove 0.6");
  {
    const put = await api('PUT', `/api/users/${userId}/settings`, { roast: 'spicy', strictness: 'strict' });
    check(
      put.status === 200 && put.json?.settings?.roast === 'spicy' && put.json?.settings?.strictness === 'strict',
      'settings updated',
      JSON.stringify(put.json?.settings)
    );
    const { status, json } = await focusCheck(userId, goalId, screen);
    check(status === 200, 'HTTP 200');
    check(json?.verdict === 'off_track', 'verdict off_track', `${json?.verdict} (${json?.reason})`);
    check(typeof json?.roast === 'string' && json.roast.trim().length > 0, 'roast is non-empty', JSON.stringify(json?.roast));
    check(!/\b(fuck|shit|bitch|asshole|bastard)\b/i.test(json?.roast ?? ''), 'roast is still PG', JSON.stringify(json?.roast));
    check(json?.notifyAbove === 0.6, 'notifyAbove matches strictness strict (0.6)', JSON.stringify(json?.notifyAbove));
    console.log(`    [roast spicy]   ${JSON.stringify(json?.roast)}`);
  }

  console.log("9. PUT {strictness: 'relaxed', roast: 'mild'} -> notifyAbove 0.85");
  {
    await api('PUT', `/api/users/${userId}/settings`, { strictness: 'relaxed', roast: 'mild' });
    const { status, json } = await focusCheck(userId, goalId, screen);
    check(status === 200, 'HTTP 200');
    check(json?.verdict === 'off_track', 'verdict off_track');
    check(typeof json?.roast === 'string' && json.roast.trim().length > 0, 'mild roast non-empty', JSON.stringify(json?.roast));
    check(json?.notifyAbove === 0.85, 'notifyAbove matches strictness relaxed (0.85)', JSON.stringify(json?.notifyAbove));
  }

  console.log("10. PUT {shareGoalTitle: false} -> accepted (points title cleared, fail soft)");
  {
    const { status, json } = await api('PUT', `/api/users/${userId}/settings`, { shareGoalTitle: false });
    check(status === 200 && json?.settings?.shareGoalTitle === false, 'shareGoalTitle false saved', JSON.stringify(json?.settings));
  }

  console.log('11. corrupt stored settings -> getSettings drops unknown keys, repairs invalid values');
  {
    await run('MATCH (u: NSUser {id: $id}) SET u.settings = $raw', {
      id: userId,
      raw: '{"helpfulness":"loud","checkSeconds":9999,"notifications":"yes","whatever":1}',
    });
    const s = await getSettings(userId);
    check(
      s.helpfulness === 'balanced' && s.checkSeconds === 20 && s.notifications === true && s.sounds === true,
      'invalid values replaced by defaults',
      JSON.stringify(s)
    );
  }

  console.log('12. cleanup');
  {
    const removed = await deleteNonSeededUsersByName(NAME);
    check(removed >= 1, 'test user deleted', String(removed));
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('all settings acceptance checks passed');
  }
}

main()
  .then(async () => {
    await close().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error('settings test crashed:', err);
    await close().catch(() => undefined);
    await deleteNonSeededUsersByName(NAME).catch(() => undefined);
    process.exit(1);
  });
