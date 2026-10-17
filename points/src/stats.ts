// Pure stat computations for the points service. No I/O happens here, so
// everything in this module is unit-testable without Neo4j or the server.

export const MINUTE_MS = 60_000;
export const LIVE_WINDOW_MS = 120_000;

export interface RawInterval {
  source: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
}

export interface MergedInterval {
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface Stats {
  points: number;
  focusedMinutes: number;
  todayMinutes: number;
  streak: number;
  lastActiveAt: string | null;
  live: boolean;
  sources: string[];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local calendar day key (server timezone), e.g. "2026-10-17". */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Shift a day key by whole days. Computes from local noon so DST shifts cannot skip a day. */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return dayKeyOf(new Date(y, m - 1, d, 12).getTime() + days * 86_400_000);
}

/** Local midnight (epoch ms) of the day containing `ms`. */
export function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Union of intervals: sorted by start, overlapping and nested ranges merged. */
export function unionIntervals(intervals: readonly MergedInterval[]): MergedInterval[] {
  const sorted = [...intervals]
    .filter(iv => iv.end > iv.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MergedInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/** Total union duration rounded down to whole minutes. */
export function unionMinutes(merged: readonly MergedInterval[]): number {
  let total = 0;
  for (const iv of merged) total += iv.end - iv.start;
  return Math.floor(total / MINUTE_MS);
}

/** Union duration in ms per local calendar day; intervals crossing midnight are split. */
export function minutesPerDay(merged: readonly MergedInterval[]): Map<string, number> {
  const perDay = new Map<string, number>();
  for (const { start, end } of merged) {
    let cursor = start;
    while (cursor < end) {
      const d = new Date(cursor);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const segEnd = Math.min(end, dayEnd);
      const key = dayKeyOf(cursor);
      perDay.set(key, (perDay.get(key) ?? 0) + (segEnd - cursor));
      cursor = segEnd;
    }
  }
  return perDay;
}

/** Days (local keys) with at least one verified minute of union time. */
export function activeDays(merged: readonly MergedInterval[]): Set<string> {
  const days = new Set<string>();
  for (const [key, ms] of minutesPerDay(merged)) {
    if (ms >= MINUTE_MS) days.add(key);
  }
  return days;
}

/** Consecutive active days ending today or yesterday. */
export function streakFromDays(days: ReadonlySet<string>, now: number): number {
  const today = dayKeyOf(now);
  let cursor = days.has(today) ? today : shiftDayKey(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
}

/** Compute the mutable part of a leaderboard row from a player's raw intervals. */
export function computeStats(intervals: readonly RawInterval[], now: number): Stats {
  const parsed = intervals
    .map(iv => ({ source: iv.source, start: Date.parse(iv.start), end: Date.parse(iv.end) }))
    .filter(iv => Number.isFinite(iv.start) && Number.isFinite(iv.end));
  const merged = unionIntervals(parsed);
  const focusedMinutes = unionMinutes(merged);
  const todayMs = minutesPerDay(merged).get(dayKeyOf(now)) ?? 0;
  const streak = streakFromDays(activeDays(merged), now);
  const lastActiveMs = parsed.length ? Math.max(...parsed.map(iv => iv.end)) : null;
  return {
    points: focusedMinutes + 25 * streak,
    focusedMinutes,
    todayMinutes: Math.floor(todayMs / MINUTE_MS),
    streak,
    lastActiveAt: lastActiveMs === null ? null : new Date(lastActiveMs).toISOString(),
    live: lastActiveMs !== null && Math.abs(now - lastActiveMs) <= LIVE_WINDOW_MS,
    sources: [...new Set(parsed.map(iv => iv.source))].sort(),
  };
}

/**
 * Sort rows by points desc then name asc and assign 1-based competition ranks:
 * rows with equal points share the lower rank, the next distinct points skips ahead.
 */
export function rankRows<T extends { name: string; points: number }>(rows: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort(
    (a, b) => b.points - a.points || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  let prevPoints: number | null = null;
  let prevRank = 0;
  return sorted.map((row, index) => {
    const rank = prevPoints === row.points ? prevRank : index + 1;
    prevPoints = row.points;
    prevRank = rank;
    return { ...row, rank };
  });
}

const DEFAULT_COLORS = [
  '#8ecbff', '#ffd59e', '#c9a7ff', '#9effd8',
  '#ff9ec4', '#fff3b0', '#a7c4ff', '#ffb38a',
] as const;

/** Deterministic default color picked by hashing the player's name. */
export function defaultColor(nameLower: string): string {
  let hash = 2166136261;
  for (let i = 0; i < nameLower.length; i += 1) {
    hash ^= nameLower.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return DEFAULT_COLORS[(hash >>> 0) % DEFAULT_COLORS.length];
}
