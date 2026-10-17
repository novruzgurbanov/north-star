/**
 * Client for the shared points service (see ../../POINTS.md).
 * Every call fails soft: it logs one short line and returns null, so North Star
 * keeps working when the points service or the tunnel is down.
 */
import 'dotenv/config';

export interface PointsPlayer {
  id: string;
  name: string;
  color: string;
  goalTitle: string | null;
  createdAt: string;
}

export interface PointsRow extends PointsPlayer {
  rank: number;
  points: number;
  focusedMinutes: number;
  todayMinutes: number;
  streak: number;
  lastActiveAt: string | null;
  live: boolean;
  sources: string[];
}

const BASE = (process.env.POINTS_URL || 'http://localhost:8788').replace(/\/+$/, '');
const KEY = process.env.POINTS_KEY || '';

async function call<T>(op: string, method: string, path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-points-key': KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`[points] ${op} failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[points] ${op} failed: ${err instanceof Error ? err.message : 'error'}`);
    return null;
  }
}

export async function upsertPlayer(input: { name: string; color: string; goalTitle?: string | null }) {
  const res = await call<{ player: PointsPlayer }>('upsertPlayer', 'POST', '/v1/players', input);
  return res?.player ?? null;
}

export async function setGoalTitle(playerId: string, goalTitle: string | null) {
  const res = await call<{ player: PointsPlayer }>('setGoalTitle', 'PATCH', `/v1/players/${encodeURIComponent(playerId)}`, {
    goalTitle: goalTitle ? goalTitle.slice(0, 80) : null,
  });
  return res?.player ?? null;
}

export async function getRow(playerId: string) {
  const res = await call<{ row: PointsRow }>('getRow', 'GET', `/v1/players/${encodeURIComponent(playerId)}`);
  return res?.row ?? null;
}

export async function reportFocus(input: {
  id: string; playerId: string; start: string; end: string; goalTitle?: string;
}) {
  const res = await call<{ row: PointsRow }>('reportFocus', 'POST', '/v1/focus', {
    ...input,
    source: 'north-star',
    goalTitle: input.goalTitle?.slice(0, 80),
  });
  return res?.row ?? null;
}

export async function leaderboard(): Promise<{ rows: PointsRow[]; offline: boolean }> {
  const res = await call<{ rows: PointsRow[] }>('leaderboard', 'GET', '/v1/leaderboard');
  return res ? { rows: res.rows, offline: false } : { rows: [], offline: true };
}
