# DONE — quick-capture goals (brainstorm stars)

Implements `BRIEF-capture.md` exactly. All work is inside `server/` plus the allowed `../CONTRACT.md` edit. `discover` is kept exported but unused; every other route and behaviour unchanged; `.env` values never printed; nothing committed; the user's server on :8787 was never touched.

## What was built

| File | Change |
|---|---|
| `src/types.ts` | `Goal` gains `status: 'brainstorm' \| 'ready'` and `missing: Array<'success' \| 'steps' \| 'why'>` (in that order, only still-empty ones). `AgentEvent` gains `{ type: 'details_updated'; goalId; goal: Goal }` and `{ type: 'goal_ready'; goalId }` |
| `src/model.ts` | `toGoal` now computes `status` (`ready` = successLooksLike non-empty **and** ≥1 milestone), `missing`, and brightness: brainstorm = `0.12 + 0.04 * (filled among why, successLooksLike, deadline, ≥1 milestone)`, ready = the existing formula unchanged. `createGoal` drops the `titles.length === 0 → null` early return (empty `UNWIND` creates no milestones, goal + `PURSUES` still created). New `updateGoalDetails(userId, goalId, details)`: sets only non-empty string fields (title capped 6 words/80 chars, why & successLooksLike 200, deadline 60) via `coalesce` SETs, returns the fresh Goal or null if not theirs |
| `src/agent.ts` | New `capture(messages)` with the brief's verbatim system prompt → `{ isGoal, title, reply, suggestions }` (title capped 6 words/80 chars; on LLM/parse failure falls back to `isGoal: false` + `FALLBACK_REPLY`). Coach prompt replaced verbatim (brainstorm: one question about the first `missing` item; ready: accountant of effort). `goalJson` passed to the coach now includes `status` and `missing`. Parser handles `set_details` (string fields only, non-empty kept) and caps `add_milestone` at 4 per turn, each title 6 words/80 chars. `discover` + its prompt kept exported but unused |
| `src/index.ts` | `POST /api/chat` without `goalId` calls `capture`: if `isGoal` and a title → `createGoal(userId, { title, why: '', successLooksLike: '', deadline: null, milestones: [] })`, `goal_created` event, `understanding: 1`, points title shared exactly as before (`ensurePlayer` + `setGoalTitle`); otherwise no event, `understanding: 0`. `phase: 'discovering'`, suggestions returned either way. With `goalId`: `set_details` → `updateGoalDetails` → `details_updated` (fresh goal); after all actions, a `brainstorm → ready` transition emits `goal_ready`; existing event types untouched. `applyCoachAction` now typed with `CoachAction` |
| `scripts/capture-test.ts` | New acceptance script (run against a server on :8790): creates `Zz Capture Test`, walks the 4-turn flow with per-turn checks, prints every reply + suggestions + the final goal, then deletes the user |
| `../CONTRACT.md` | Goal type (`status`, `missing`, brightness comment), AgentEvent (+`details_updated`, +`goal_ready`), `/api/chat` flow bullets (phase / understanding / details+goal_ready), scoring brightness line for brainstorm stars |

## Acceptance checks (all run)

1. `npx tsc --noEmit` — passes (run after each change; `scripts/` is in the tsconfig include).
2. Server started in the background: `API_PORT=8790 POINTS_URL=http://localhost:9 npm start` (health `{ok:true,neo4j:true,llm:true}` after 1 s), then `npx tsx scripts/capture-test.ts` — **all checks passed**. Transcript (replies and suggestions as printed by the script):

   - **Turn 1 — `POST /api/chat`, only "I want to learn to play guitar"** → `goal_created` in the same response, goal `status: 'brainstorm'`, `milestones: []`, `missing: ["success","steps","why"]`, `understanding: 1`.
     - reply: `"Your goal to learn to play guitar now has its little star in your sky under Brainstorm, and you can add details whenever you like. What would success look like for you?"` (168 chars)
     - suggestions: `["Play a full song","Strum along to my favorite songs","Just learn the basic chords"]` (3)
   - **Turn 2 — "hi" (no goalId)** → no events, `understanding: 0`, goals stayed 1 → 1.
     - reply: `"Hi! Write down something you'd like to reach, and I'll catch it as a goal."`
     - suggestions: `["I want to get fit","Learn a new language","Save money for a trip"]`
   - **Turn 3 — with goalId: "I'll know I made it when I can play Wonderwall for friends"** → `details_updated` with `successLooksLike: "Play Wonderwall for friends"`, `missing: ["steps","why"]` (no `success`), goal still `brainstorm`.
     - reply: `"Playing Wonderwall for friends is a clear finish line — I've lit it up as your success. What's the first step you'd take toward it?"`
     - suggestions: `["Learn the basic open chords","Get a guitar first","Practice 15 minutes a day"]`
   - **Turn 4 — "First I'll buy a guitar, learn 4 chords, then practice 15 min a day"** → 3 × `milestone_added` then `goal_ready`; goal `status: 'ready'`, `missing: ["why"]`.
     - reply: `"Three stars mapped: buy a guitar, learn 4 chords, practice 15 minutes a day. One quick thing before we light them up — why does guitar matter to you?"`
     - suggestions: `["It's always been a dream of mine","To unwind after work","To play with friends"]`
     - final goal: `{"title":"Learn to play guitar","why":"","successLooksLike":"Play Wonderwall for friends","deadline":null,"status":"ready","missing":["why"],"brightness":0.25,"milestones":[Buy a guitar, Learn 4 chords, Practice 15 minutes a day (all undone, 0.18)]}`
   - Cleanup inside the script: `deleteNonSeededUsersByName('Zz Capture Test')` → 1 removed.
3. Server stopped (`taskkill` on the :8790 listener PID); **port 8790 verified free** (netstat shows no listener).
4. `../CONTRACT.md` updated as listed above.

## Regression verification (extra, beyond the brief)

`scripts/accept.ts` cannot run against the isolated test server (it asserts 9 leaderboard rows from the points service, which is deliberately unreachable on :9, and its discover-flow section is intentionally obsolete after this brief). So the untouched surfaces were verified directly with a temporary script (deleted after the run, server still on :8790):

- All 11 seeded goals still `status: 'ready'`, `missing: []`; Kenji's brightness still exactly **0.9** (`0.25 + 0.6·5/6 + 0.15`) — the ready formula is untouched.
- `updateGoalDetails` caps (title 6 words/27 chars from a 12-word input, why 200, success 200, deadline 60), foreign user → `null`, whitespace-only values change nothing, success + milestone → `ready`.
- Coach on a **ready** goal: "I did my first training run this morning, 30 minutes, first milestone done!" → `milestone_done` + `focus_logged`, **no** `goal_ready` (already ready), milestone marked done, stats `milestonesDone=1 focusedMinutes=30`, reply: `"First run in the books — 30 minutes this morning, that's your first star lit. How did it feel out there?"`
- `npx tsc --noEmit` re-run clean after removing the temp script.

## Notes / things that did not work

- The user's running server occupies :8787 and the real points service :8788, so nothing was started there; all tests used `API_PORT=8790` + `POINTS_URL=http://localhost:9`. The `[points] upsertPlayer failed: fetch failed` warnings during the test are the intended fail-soft path; `goal_created` still fires and `ensurePlayer` simply returns null.
- The kill of the background server makes the shell report "exited with code 1" — that is the force-kill for cleanup, not a crash (same as noted in `DONE-whisper.md`).
- First regression-script draft had two self-inflicted failures (it never passed `successLooksLike`, and it built the "ready" fixture without milestones, so `brainstorm` was the *correct* status both times). Fixed the fixture, not the code; final run is fully green.
- `capture` failing LLM/parse falls back to `isGoal: false` → no event, `understanding: 0`, `FALLBACK_REPLY` — a stated goal in that rare case would need to be re-sent; same fail-soft philosophy as the rest of the agent.
