# DONE — shared public goals per player

Implementation of the "Shared goals" section of `../POINTS.md` per `BRIEF-goals.md`.
All work stayed inside this `points` folder. The key in `.env` was read inside the
shell only and never printed. No git commits. The user's live service on 8788 was
never touched (verified still healthy mid-run); tests ran against a separate
server on **8796**.

## What was built

```
src/db.ts      new unique constraint: ps_goal_key  FOR (g:PSGoal) REQUIRE g.key IS UNIQUE
src/index.ts   PublicGoal type + goals zod schema + PUT /v1/players/:id/goals
               + toGoals() helper + loadRows() now returns goals on every Row
src/seed.ts    each seeded player gets 1-3 public goals; seed cleanup deletes
               seeded players' PSGoal nodes too; player MERGE now RETURNs the
               real id so intervals and goals always attach to the right node
```

- **Storage**: `(:PSPlayer)-[:SHARES]->(:PSGoal {key, goalId, title, status,
  brightness, milestonesDone, milestonesTotal, ord, updatedAt})` with
  `key = playerId + ':' + goalId`, unique constraint created `IF NOT EXISTS` at boot.
- **PUT replaces the whole set in one transaction**: a single Cypher statement
  (`FOREACH … DETACH DELETE` the player's old PSGoal nodes, then `UNWIND` the
  new list and `MERGE` each goal with `ord` = array index). One statement via
  `executeQuery` = one managed transaction, so an empty list simply deletes
  everything and no partial state can be left behind.
- **Validation (zod)**: `goals` array max 12; `id` 1–64 chars; `title` 1–80 chars
  trimmed; `status` enum `brainstorm | ready`; `brightness` 0..1;
  `milestonesDone`/`milestonesTotal` integers 0..100 with a refine that
  `done <= total`. Duplicate ids in one request → 400 before any write;
  unknown player → 404.
- **Rows**: every `Row` (leaderboard, player row, focus/PUT responses — all go
  through `loadRows`) now carries `goals: PublicGoal[]` ordered by `ord`
  (`ord` is used for sorting then stripped from the response). The goals load is
  a second `OPTIONAL MATCH` **after** the interval `collect` aggregation, so
  interval rows are not multiplied.
- **Seed**: 18 public goals across the 9 players — the existing goal title is
  always the first goal, plus 0–2 fitting extras; brightness 0.3–1 and varied
  milestone counts, mixed `ready`/`brainstorm` (constellations of 1–3 stars).

## Acceptance check results

1. `npx tsc --noEmit` — **passes**. `npx tsx --test tests/stats.test.ts` —
   **12/12 pass** (existing tests untouched and green).
2. `npm run seed` — **passes**: `Seeded 9 players with 478 intervals and 18
   public goals`; same points table as before, so it only replaced seeded data.
3. Background server on `POINTS_PORT=8796` (shell env var wins over `.env`):
   - `PUT /v1/players/:id/goals` with 2 goals for the `Test Goals` player →
     `row.goals` = `[alpha (ready, 0.8, 3/5), beta (brainstorm, 0.3, 0/2)]`
     in published order.
   - `PUT … {"goals":[]}` → `row.goals` = `[]`.
   - 13 goals → **400** `invalid request: goals: Too big: expected array to have
     <=12 items`.
   - duplicate ids → **400** `duplicate goal id: same`.
   - unknown player → **404** `player not found`.
   - `GET /v1/leaderboard?mode=demo` → 13 rows, **every row has a `goals`
     array**; all 9 seeded players have 1–3 goals in `ord` order (Marcus 3,
     Sofia 3, Aiko/Lena/Ravi/Amara/Mei 2, Kenji/Tom 1); real players show `[]`.
   - Cleanup: `Test Goals` player + its intervals + PSGoal nodes deleted via a
     direct Cypher call (`1` player removed, `0` orphan PSGoal nodes left);
     real-mode leaderboard back to exactly the pre-test rows
     (Noah, Andrew, Novruz); server killed; **port 8796 free** (netstat empty,
     curl connection refused).

## Notes

- The 400 for `done > total` comes from the schema refine, e.g.
  `invalid request: goals.0: milestonesDone must be <= milestonesTotal`.
- Goal ids are the app's own ids; uniqueness is per player, enforced by the
  composite `PSGoal.key` constraint (also makes a retried/idempotent PUT safe).
- Nothing else changed: no endpoints removed, `.env` never printed, no commits.
