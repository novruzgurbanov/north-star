# Brief: shared public goals per player

Implement the "Shared goals" section and the new `PUT /v1/players/:id/goals` route in `../POINTS.md` (read it first). Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\points`. Never print `.env`. No git commits. The real service is running on port 8788 right now for the user, so do NOT bind 8788: run your tests with `POINTS_PORT=8796` set in the shell, server in the background, stopped at the end.

## Storage
`(:PSPlayer)-[:SHARES]->(:PSGoal {key, goalId, title, status, brightness, milestonesDone, milestonesTotal, ord, updatedAt})` where `key = playerId + ':' + goalId` (unique constraint on `PSGoal.key`). The PUT replaces the set in one transaction: delete the player's existing PSGoal nodes, create the new ones with `ord` = array index. Include PSGoal in the seed cleanup.

## Validation (zod)
`goals` array max 12; `id` 1-64 chars; `title` 1-80 chars trimmed; `status` enum; `brightness` 0..1; `milestonesDone`/`milestonesTotal` integers 0..100 with done <= total. Unknown player → 404. Duplicate ids in one request → 400.

## Rows
Every `Row` (leaderboard, player row, focus response) gains `goals: PublicGoal[]` ordered by `ord`. Load them without multiplying interval rows (separate OPTIONAL MATCH + collect, or a second query).

## Seed
Give each of the 9 seeded players 1-3 public goals (their existing goal title first, plus one or two more fitting goals) with varied brightness and milestone counts, so Demo mode shows constellations of 1-3 stars.

## Acceptance
1. `npx tsc --noEmit`; `npx tsx --test tests/stats.test.ts` still green.
2. `npm run seed` (it is safe: only seeded players are replaced).
3. Background server on 8796: PUT 2 goals for a `Test Goals` player → row has them in order; PUT `[]` → none; 13 goals → 400; duplicate ids → 400; unknown player → 404; leaderboard `?mode=demo` rows include `goals`. Delete the Test Goals player (and its PSGoal nodes), stop the server, port 8796 free.

Write `DONE-goals.md` with the results.
