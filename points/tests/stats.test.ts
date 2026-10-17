// Unit tests for src/stats.ts — pure functions, no database needed.
// Run with: npx tsx --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStats,
  dayKeyOf,
  localMidnight,
  minutesPerDay,
  rankRows,
  shiftDayKey,
  streakFromDays,
  unionIntervals,
  unionMinutes,
} from '../src/stats.js';

const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

test('union merges overlapping and nested intervals', () => {
  const merged = unionIntervals([
    { start: 0, end: 10 },
    { start: 20, end: 25 },
    { start: 5, end: 15 }, // overlaps the first
    { start: 7, end: 12 }, // nested inside the merged first
    { start: 25, end: 30 }, // touches the second
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 15 },
    { start: 20, end: 30 },
  ]);
});

test('union keeps disjoint intervals apart', () => {
  const merged = unionIntervals([
    { start: 10, end: 20 },
    { start: 0, end: 5 },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
  ]);
});

test('unionMinutes floors to whole minutes', () => {
  assert.equal(unionMinutes(unionIntervals([{ start: 0, end: 90_500 }])), 1);
  assert.equal(unionMinutes(unionIntervals([{ start: 0, end: 59_999 }])), 0);
});

test('an interval across midnight splits into two days', () => {
  const now = Date.now();
  const midnight = localMidnight(now);
  const perDay = minutesPerDay([{ start: midnight - 30 * MIN, end: midnight + 30 * MIN }]);
  const yesterday = dayKeyOf(midnight - MIN);
  const today = dayKeyOf(midnight + MIN);
  assert.equal(perDay.size, 2);
  assert.equal(perDay.get(today), 30 * MIN);
  assert.equal(perDay.get(yesterday), 30 * MIN);
});

test('overlapping intervals across midnight are counted once per day', () => {
  const now = Date.now();
  const midnight = localMidnight(now);
  const merged = unionIntervals([
    { start: midnight - 40 * MIN, end: midnight + 10 * MIN },
    { start: midnight - 20 * MIN, end: midnight + 25 * MIN }, // nested overlap
  ]);
  const perDay = minutesPerDay(merged);
  const yesterday = dayKeyOf(midnight - MIN);
  const today = dayKeyOf(midnight + MIN);
  assert.equal(perDay.get(yesterday), 40 * MIN);
  assert.equal(perDay.get(today), 25 * MIN);
});

test('streak counts today or yesterday as the end', () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const d = (n: number) => shiftDayKey(today, -n);
  assert.equal(streakFromDays(new Set([today, d(1), d(2)]), now), 3);
  // today not active yet: yesterday still continues the streak
  assert.equal(streakFromDays(new Set([d(1), d(2), d(3)]), now), 3);
  // nothing today or yesterday: streak broken
  assert.equal(streakFromDays(new Set([d(2), d(3), d(4)]), now), 0);
  // a gap breaks the run
  assert.equal(streakFromDays(new Set([today, d(2)]), now), 1);
});

test('ties share a rank and the next rank skips ahead', () => {
  const ranked = rankRows([
    { name: 'bravo', points: 30 },
    { name: 'alpha', points: 30 },
    { name: 'charlie', points: 50 },
    { name: 'delta', points: 10 },
  ]);
  assert.deepEqual(
    ranked.map(r => [r.name, r.rank]),
    [
      ['charlie', 1],
      ['alpha', 2],
      ['bravo', 2],
      ['delta', 4],
    ],
  );
});

test('computeStats unions overlapping intervals, reports live and sources', () => {
  const now = Date.now();
  const stats = computeStats(
    [
      { source: 'north-star', start: iso(now - 10 * MIN), end: iso(now - 4 * MIN) },
      { source: 'goal-coach', start: iso(now - 7 * MIN), end: iso(now - 1 * MIN) }, // overlaps
      { source: 'north-star', start: iso(now - 30 * MIN), end: iso(now - 29 * MIN) }, // disjoint
    ],
    now,
  );
  assert.equal(stats.focusedMinutes, 10);
  assert.equal(stats.live, true);
  assert.equal(stats.lastActiveAt, iso(now - MIN));
  assert.deepEqual(stats.sources, ['goal-coach', 'north-star']);
});

test('points, streak and todayMinutes from constructed intervals', () => {
  const now = Date.now();
  const midnight = localMidnight(now);
  const stats = computeStats(
    [
      { source: 'a', start: iso(midnight + 30 * MIN), end: iso(midnight + 55 * MIN) }, // 25 min today
      { source: 'a', start: iso(midnight - 20 * MIN), end: iso(midnight - 5 * MIN) }, // 15 min yesterday
    ],
    now,
  );
  assert.equal(stats.focusedMinutes, 40);
  assert.equal(stats.todayMinutes, 25);
  assert.equal(stats.streak, 2);
  assert.equal(stats.points, 40 + 2 * 25);
});

test('a day with under a minute does not count for the streak', () => {
  const now = Date.now();
  const midnight = localMidnight(now);
  const stats = computeStats(
    [
      { source: 'a', start: iso(midnight + 60 * MIN), end: iso(midnight + 61 * MIN - 30_000) }, // 30 s today
      { source: 'a', start: iso(midnight - 90 * MIN), end: iso(midnight - 89 * MIN) }, // 1 min yesterday
    ],
    now,
  );
  assert.equal(stats.todayMinutes, 0);
  assert.equal(stats.streak, 1); // yesterday only
  assert.equal(stats.points, 1 + 25);
});

test('an interval that ended long ago is not live', () => {
  const now = Date.now();
  const stats = computeStats(
    [{ source: 'a', start: iso(now - 5 * MIN), end: iso(now - 3 * MIN) }],
    now,
  );
  assert.equal(stats.live, false);
});

test('a player with no intervals has zeroed stats', () => {
  const stats = computeStats([], Date.now());
  assert.deepEqual(stats, {
    points: 0,
    focusedMinutes: 0,
    todayMinutes: 0,
    streak: 0,
    lastActiveAt: null,
    live: false,
    sources: [],
  });
});
