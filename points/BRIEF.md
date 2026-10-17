# Brief: shared points service

Build the service specified in `../POINTS.md`. Read it first and follow it exactly (paths, shapes, rules, formulas). Two apps on two laptops will call it during a hackathon demo in about 2 hours, so favour simple and robust.

Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\points`. Never print or log `.env` values (including `POINTS_KEY`). There is no git repo; do not commit.

## Stack (installed, see package.json)

Node 24, TypeScript run with `tsx`, ESM. `express` v5, `cors`, `dotenv`, `neo4j-driver`, `zod`, `nanoid`. `.env` already has `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `POINTS_KEY`, `POINTS_PORT=8788`. Read the port from `POINTS_PORT` (not `PORT`).

## Storage: local Neo4j, labels prefixed `PS` (other apps share this database; touch nothing else)

```
(:PSPlayer {id, name, nameLower, color, goalTitle, seeded, createdAt})
(:PSPlayer)-[:LOGGED]->(:PSInterval {id, source, start, end, createdAt})   // start/end ISO strings
```

Unique constraints on `PSPlayer.id`, `PSPlayer.nameLower`, `PSInterval.id` (create `IF NOT EXISTS` at boot). Use `MERGE` on the interval id so a retried POST is a no-op.

Compute stats in TypeScript on read: load a player's intervals, sort, merge overlaps (union), sum the duration. Streak and `todayMinutes` use the server's local calendar day; a day counts when the union has at least 1 minute on that day (split intervals that cross midnight). `live` = the latest `end` is within 120 s of now. `points = focusedMinutes + 25 * streak`. Ties share a rank.

Default colors when none is given: pick by name hash from `['#8ecbff','#ffd59e','#c9a7ff','#9effd8','#ff9ec4','#fff3b0','#a7c4ff','#ffb38a']`.

## Files

```
src/index.ts    express app, key middleware (x-points-key, constant-time compare; /v1/health is open), CORS open, routes, {error} handler
src/db.ts       driver + constraints + run() helper converting Neo4j integers
src/stats.ts    interval union, minutes, today, streak, points, ranking (pure functions)
src/seed.ts     `npm run seed`
tests/stats.test.ts   unit tests for stats.ts with node:test (run with `npx tsx --test tests/`)
```

Validation with zod. `name` 1–32 chars trimmed; `goalTitle` up to 80 chars (null clears it); `color` must match `^#[0-9a-fA-F]{6}$`; `source` 1–24 chars `[a-z0-9-]`; focus interval rules exactly as in POINTS.md (400 on violation). Unknown player on `/v1/focus` or `/v1/players/:id` → 404.

## Seed (`npm run seed`)

Delete `PSPlayer {seeded:true}` and their intervals, then create these 9 demo players with goal titles and intervals spread over the last 10 days (deterministic, relative to now), so points range roughly 80–1400 and streaks 0–9, with 1–2 of them `live` (an interval ending ~30 s before the seed runs):
Aiko "Pass JLPT N3", Marcus "Ship my indie game demo", Lena "Learn Clair de Lune", Ravi "Get my first ML internship", Sofia "Launch a ceramics shop", Kenji "Run a half marathon", Amara "Read 24 books this year", Tom "Cook through a Japanese cookbook", Mei "Finish my thesis draft". Sources: mix of `north-star` and `goal-coach`.

## Acceptance checks (run them yourself)

1. `npx tsc --noEmit` passes (create tsconfig: strict, NodeNext, ES2022, noEmit; include src and tests).
2. `npx tsx --test tests/` passes: overlapping and nested intervals union correctly; an interval across midnight splits into two days; streak counts today or yesterday as the end; ties share a rank.
3. `npm run seed` works.
4. Start the server in the background, then with curl: health without a key → 200; leaderboard without a key → 401; with the key → 9 rows sorted by points; `POST /v1/players {"name":"Test"}` twice returns the same id; `POST /v1/focus` for 10 minutes adds 10 to focusedMinutes; re-POSTing the same id changes nothing; an overlapping 10-minute interval shifted by 5 minutes adds only 5; a 20-minute interval → 400; a future interval → 400. Read the key from `.env` inside your shell command without echoing it. Delete the Test player afterwards, stop the server, and make sure port 8788 is free.

Write `DONE.md` here: what you built, how to run it, test results, and anything that did not work.
