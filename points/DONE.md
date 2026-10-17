# DONE — shared points service

Implementation of `../POINTS.md` (brief in `BRIEF.md`). Everything lives in this
folder; no other app data in the shared Neo4j database was touched (all labels
are prefixed `PS*`).

## What was built

```
src/index.ts    express app: open GET /v1/health, x-points-key middleware
                (constant-time compare via sha256 + timingSafeEqual), open CORS,
                all 6 endpoints, JSON error handler (zod -> 400, bad JSON -> 400,
                unknown player -> 404, other -> 500), graceful shutdown
src/db.ts       neo4j driver, PS* unique constraints created IF NOT EXISTS at
                boot, run() helper that converts neo4j.Integer to JS numbers
src/stats.ts    pure functions: interval union (overlaps/nesting merged),
                minutes (floored), per-local-day split at midnight, streak
                (days with >= 1 min, ending today or yesterday),
                points = focusedMinutes + 25 * streak, competition ranking
                (ties share a rank), name-hash default colors
src/seed.ts     npm run seed — deletes PSPlayer {seeded:true} + their intervals,
                then creates the 9 demo players deterministically relative to now
tests/stats.test.ts   12 node:test unit tests for stats.ts
tsconfig.json   strict, NodeNext, ES2022, noEmit, includes src and tests
```

- Storage: `(:PSPlayer {id, name, nameLower, color, goalTitle, seeded, createdAt})`
  and `(:PSPlayer)-[:LOGGED]->(:PSInterval {id, source, start, end, createdAt})`
  with start/end stored as ISO strings, exactly as specified.
- `POST /v1/focus` validates 5 s – 15 min duration, end ≤ 60 s in the future,
  start ≥ 48 h old (400 otherwise), MERGEs on the client-supplied interval id so
  retries are no-ops, guards against an id already owned by another player, and
  returns the fresh ranked row.
- `POST /v1/players` upserts by case-insensitive name (same name from two apps =
  same player); `color`/`goalTitle` are updated only when given; explicit
  `goalTitle: null` clears it; missing color gets a deterministic name-hash color.

## How to run

```sh
npm start        # server on POINTS_PORT (8788) from .env
npm run seed     # reseed the 9 demo players (idempotent; replaces previous seed)
npm test         # unit tests
npm run typecheck
```

Clients send `x-points-key: <key from .env>` on every request except
`GET /v1/health`. The key is never printed or logged anywhere.

## Acceptance check results (all run before DONE.md was written)

1. `npx tsc --noEmit` — **passes**.
2. Unit tests — **12/12 pass**, covering the required cases: overlapping and
   nested intervals union correctly; an interval across midnight splits into two
   days (30/30 min, no double counting); streak counts today or yesterday as the
   end (and a gap breaks it); ties share a rank with the next rank skipping.
3. `npm run seed` — **works**: 9 players, 478 intervals, points 80 (Tom) …
   1375 (Marcus), streaks 0–9, Aiko and Mei live (last interval ends ~30 s
   before the seed runs).
4. Server + curl (key read from `.env` inside the shell, never echoed):
   - health without key → **200**; leaderboard without key → **401**
   - leaderboard with key → **9 rows**, sorted by points desc then name, ranks
     correct (1,2,3,…; ties would share)
   - `POST /v1/players {"name":"Test"}` twice → **same id** both times
   - 10-minute focus → focusedMinutes **10**; re-POST same id → **unchanged**
   - overlapping 10-minute interval shifted 5 min → focusedMinutes **15** (+5 only)
   - 20-minute interval → **400**; future interval → **400**
   - Test player deleted afterwards (leaderboard back to exactly 9 rows),
     server stopped, port 8788 verified free (`netstat` empty, curl refused).

Leaderboard at acceptance time:

| rank | name   | points | focused | today | streak | live | sources                |
|-----:|--------|-------:|--------:|------:|-------:|------|------------------------|
| 1    | Marcus | 1375   | 1150m   | 130m  | 9      |      | goal-coach+north-star  |
| 2    | Amara  | 1000   | 800m    | 100m  | 8      |      | goal-coach+north-star  |
| 3    | Aiko   | 965    | 740m    | 85m   | 9      | LIVE | north-star             |
| 4    | Lena   | 795    | 620m    | 90m   | 7      |      | goal-coach+north-star  |
| 5    | Ravi   | 665    | 540m    | 110m  | 5      |      | goal-coach             |
| 6    | Sofia  | 455    | 380m    | 125m  | 3      |      | goal-coach+north-star  |
| 7    | Mei    | 145    | 95m     | 50m   | 2      | LIVE | goal-coach+north-star  |
| 8    | Kenji  | 140    | 140m    | 0m    | 0      |      | north-star             |
| 9    | Tom    | 80     | 55m     | 55m   | 1      |      | goal-coach             |

## Things that did not work (and fixes)

- `npx tsx --test tests/` (the literal command from the brief) fails on this
  machine: **Node 24.13.0's test runner no longer treats a bare directory as a
  path argument** (since Node 23, path args are glob patterns), so it tries to
  import the `tests` directory as a module and dies with
  `ERR_UNSUPPORTED_DIR_IMPORT`. Plain `node --test tests/` with a `.mjs` test
  fails the same way, so it is an upstream Node change, not a bug in this code.
  Equivalent commands that pass: `npx tsx --test "tests/**/*.test.ts"`,
  `npx tsx --test tests/stats.test.ts`, and `npm test` (the package.json test
  script now uses the glob form).
- First `npm run seed` attempt failed with
  `MERGE ... property value for 'id': null` — the planned intervals were missing
  their `id` field. Fixed in `src/seed.ts`; the seed now runs clean.
- Nothing else. No known limitations beyond the spec: the 48 h / 60 s windows
  and 15 min cap are enforced exactly as written, and stats are computed on
  every read (fine at demo scale).
