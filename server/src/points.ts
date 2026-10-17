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

/** One public goal as the points service expects it (../POINTS.md, "Shared goals"). */
export interface PublicGoal {
  id: string; // the app's own goal id (unique per player)
  title: string; // max 80 chars
  status: 'brainstorm' | 'ready';
  brightness: number; // 0..1
  milestonesDone: number;
  milestonesTotal: number;
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

/** Update the points player's color (fail soft; also part of PATCH /v1/players/:id). */
export async function setPlayerColor(playerId: string, color: string) {
  const res = await call<{ player: PointsPlayer }>('setPlayerColor', 'PATCH', `/v1/players/${encodeURIComponent(playerId)}`, {
    color,
  });
  return res?.player ?? null;
}

/**
 * Replace the player's whole public goal list on the points service (max 12,
 * fail soft). An empty list makes all their goals private over there.
 */
export async function publishGoals(playerId: string, goals: PublicGoal[]) {
  const res = await call<{ row: PointsRow }>('publishGoals', 'PUT', `/v1/players/${encodeURIComponent(playerId)}/goals`, {
    goals: goals.slice(0, 12),
  });
  return res?.row ?? null;
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

/** 'real' = only people who actually connected; 'demo' also shows the seeded cast. */
export async function leaderboard(mode: 'real' | 'demo' = 'real'): Promise<{ rows: PointsRow[]; offline: boolean }> {
  const res = await call<{ rows: PointsRow[] }>('leaderboard', 'GET', `/v1/leaderboard?mode=${mode}`);
  return res ? { rows: res.rows, offline: false } : { rows: [], offline: true };
}
