# DONE — North Star backend

## What was built

Everything from `BRIEF.md`, implemented against `../CONTRACT.md` exactly (paths, body shapes, response shapes, scoring formulas). All work is inside `server/`.

| File | Purpose |
|---|---|
| `src/index.ts` | Express app: CORS open, `express.json({limit:'1mb'})`, all 8 routes, error handler that always returns `{ error }` (400/404/413/500), zod body validation |
| `src/db.ts` | Neo4j driver (db `neo4j`), unique-id constraints on `NSUser`/`NSGoal`/`NSMilestone`, `run()` query helper that converts Neo4j Integers to JS numbers |
| `src/model.ts` | `loadGoals`, `computeStats`, `toGoal` mapping, brightness math, streak (consecutive local days ending today/yesterday), user upsert, goal/milestone/activity writes, cascade delete |
| `src/agent.ts` | `discover()` and `coach()` — verbatim system prompts from the brief, `response_format: json_object` with automatic retry (dropping JSON mode if the API rejects it), first-`{...}`-block parsing, safe fallback `"Tell me a bit more about that?"` instead of a 500 |
| `src/seed.ts` | `npm run seed` — deletes old seeded users + everything hanging off them, creates the 9 demo users (Aiko, Marcus, Lena, Ravi, Sofia, Kenji, Amara, Tom, Mei) |
| `src/types.ts` | Contract types (`Goal`, `Milestone`, `Stats`, `AgentEvent`, …) |
| `scripts/accept.ts` | Acceptance suite (below); reusable with `npx tsx scripts/accept.ts` against a running server |
| `tsconfig.json` | strict, NodeNext, ES2022, noEmit |

Nothing outside `server/` was touched; `.env` and dependencies untouched.

## How to run

```bash
npm run seed        # demo users (safe to re-run; re-seeds dates relative to today)
npm start           # Express on :8787 (or npm run dev for watch mode)
npx tsx scripts/accept.ts   # optional: full acceptance suite against the running server
```

## Acceptance checks (all run and passing)

1. **`npx tsc --noEmit`** — passes.
2. **`npm run seed`** — succeeds; the seed self-verifies and prints a table. Planned scores land exactly: Kenji 1400, Aiko 1050, Ravi 840, Marcus 820, Lena 815, Sofia 760, Mei 395, Amara 250, Tom 80; streaks 9,8,7,6,5,3,2,1,0 (scores 80→1400, streaks 0→9).
3. **Server + curl/API suite** (`scripts/accept.ts`, all green):
   - `/api/health` → `{ok:true, neo4j:true, llm:true}`
   - `/api/leaderboard` → 9 seeded rows sorted by score desc with 1-based ranks
   - `/api/cosmos` → 9 users with goals (brightness verified: e.g. Kenji 0.25 + 0.6·5/6 + 0.15 = 0.9)
   - `POST /api/users {"name":"Test"}` → user; case-insensitive re-post returns the same id
   - `POST /api/chat` (1 message) → question reply, `understanding 0.2 < 0.5`, phase `discovering`
   - continued multi-turn chat → `goal_created` event with a full Goal, `understanding: 1`
   - `POST /api/activity` → score rose 0 → 55 (30 min + new streak of 1); off-task minutes stored but earn nothing; missing `goalId` falls back to the most recent goal
   - bonus: milestone toggle, coaching turn (`milestone_done`/`focus_logged` applied + returned), 400/404 error shapes
   - server stopped afterwards (port 8787 free); Test/Nobody test users deleted; leaderboard back to 9 rows
4. No git repo, nothing committed.

## Implementation notes / decisions

- **Read-time computation**: score, streak, and all brightness are computed on read, never stored. Streaks use local calendar days (DST-safe via `Date` arithmetic).
- **Seeded RNG**: the seed needs no randomness at all (fixed minutes/dates per user), so it is fully deterministic; only ids (`nanoid`) differ between runs. Re-run seed shortly before demoing so streak days stay fresh — the planned streaks hold at any time of day.
- **`POST /api/users` upsert** matches case-insensitively among *non-seeded* users only, so real users can't mutate/attach to demo data (a second "Aiko" is possible and harmless).
- **`/api/activity` with no goals** → `400 {error: "user has no goals yet"}` (the brief's check is "raises score once they have a goal"). Minutes are clamped to 1..600. `source` defaults to `"api"`; coach focus logs use `source: "chat"`, `onTask: true`.
- **Agent safety rails**: understanding clamped to [0,1]; never `ready` on the first user turn (forced `ready:false`, understanding capped 0.45); a `ready` goal missing title/why/successLooksLike/milestones is rejected and discovery continues; on double LLM/parse failure the server replies `"Tell me a bit more about that?"` with understanding approximated from history length (the server is stateless between turns) — no 500s.
- **Coach actions** are validated server-side: milestone ids must belong to the coached goal, `add_milestone` is trimmed to 6 words and linked into the `NEXT` chain, `log_focus` minutes clamped 1..600; invalid actions are silently ignored.
- **Neo4j multi-user safety**: only `NS*`-prefixed labels are touched; constraints created idempotently at boot (`IF NOT EXISTS`).

## Anything that did not work

- First acceptance run of `scripts/accept.ts` reported 4 failures that were test-ordering artifacts in the script itself (it counted the leftover "Test" user from my manual curl warm-up in the leaderboard/cosmos checks). Fixed by cleaning leftovers at the start of the script; the server was never at fault. Second run: all checks green.
- No other issues. The LLM (aiand.com, model from `CHAT_MODEL`) accepts `response_format: json_object`, so the fallback paths are belt-and-braces; they're exercised only if the API errors or returns non-JSON.
