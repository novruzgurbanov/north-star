# DONE — goal details graph + roasting focus judge

Implements `BRIEF-details.md` exactly. All work is inside `server/` plus the allowed `../CONTRACT.md` edit. Every existing route and behaviour unchanged; `.env` values never printed; nothing committed; ports 8787/8788 never touched (tests ran on **8791** with `POINTS_URL=http://localhost:9`); background server stopped by me and port 8791 verified free.

## What was built

| File | Change |
|---|---|
| `src/types.ts` | `DetailKind` + `DETAIL_KINDS` (`'subgoal' \| 'action' \| 'motivation' \| 'obstacle' \| 'distraction' \| 'on_track'`), `GoalDetail = { id, kind, text, createdAt }`. `Goal` gains `details: GoalDetail[]` (sorted by `createdAt`). `AgentEvent` gains `{ type: 'detail_added'; goalId; detail: GoalDetail }` |
| `src/model.ts` | `loadGoals`/`getGoal` gain a second `OPTIONAL MATCH (g)-[:HAS_DETAIL]->(d: NSDetail)` folded into `collect(d {.*}) AS ds` *after* the milestone collect (no row multiplication; milestones untouched). `toGoal` takes the details, maps + sorts them by `createdAt`. New `addDetail(userId, goalId, kind, text)`: rejects invalid kinds and empty text, trims text to 120 chars, skips exact duplicates per goal (case-insensitive) and refuses the 31st detail — one Cypher query with a `WHERE` guard, returns the fresh detail or null. `deleteUserCascade` (so also `deleteNonSeededUsersByName`) now `DETACH DELETE`s `NSDetail` nodes |
| `src/agent.ts` | Coach prompt: the brief's verbatim `add_detail` paragraph inserted directly before the "Also offer 2-3 suggested replies" paragraph, and `{"type":"add_detail","kind": string,"text": string}` appended to the actions union. Coach `goalJson` now includes `details` (kind + text only). Parser: `add_detail` accepted only with a valid kind + non-empty text, **max 5 per turn**. Capture prompt: the brief's verbatim `details` line before "Also offer", plus `"details": [{"kind": string, "text": string}]` in the JSON shape; `capture` returns parsed `details` (same valid-kind/non-empty-text filter). Focus judge: system prompt replaced **verbatim** with the roasting version; goal JSON gains `onTrackLooksLike` (texts of `on_track` + `action` details) and `knownDistractions` (texts of `distraction` details); `FocusVerdict` gains `roast` (trimmed, ≤ 200 chars, forced `""` unless `off_track`); failure fallback returns `roast: ''` |
| `src/index.ts` | Coaching: `add_detail` actions go through `model.addDetail` and emit `detail_added`; when the detail is a `motivation` and `why` is still empty, `updateGoalDetails(userId, goalId, { why: detail.text })` is called (tracked with a `whyEmpty` flag so a `set_details`-why in the same turn wins and no extra read is needed). Discovering: capture `details` are applied via `addDetail` right after `createGoal`, each emitting `detail_added` (before the points-service share, which is unchanged). `/api/focus/check` returns `roast` automatically via the existing `...verdict` spread |
| `scripts/details-test.ts` | New acceptance script (server on :8791): creates `Zz Details Test`, capture + coach checks, marks the goal ready via the model, generates two JPEG screenshots with `jimp` (dev dep) and runs both focus checks, prints both verdicts, deletes the user |
| `../CONTRACT.md` | `DetailKind`/`GoalDetail` types, `details` on `Goal`, `detail_added` in `AgentEvent`, `roast` in the `/api/focus/check` Returns, two short bullets (details recording + roast) |

## Acceptance checks (all run)

1. `npx tsc --noEmit` — **passes** (run after every change; `scripts/` is in the tsconfig include).
2. `scripts/details-test.ts` against a background server started with `API_PORT=8791 POINTS_URL=http://localhost:9 npm start` — **all checks passed**:

   - **capture** "I want to finish my thesis because I want to graduate, but YouTube keeps eating my evenings" → `goal_created` **and 2 × `detail_added`**: `{kind: "motivation", text: "I want to graduate"}`, `{kind: "distraction", text: "YouTube keeps eating my evenings"}`; the returned goal carries both; reply: *"Finish my thesis — its little star is now in your sky under Brainstorm, and graduation is a great reason to reach for it. What would a good writing evening look like for you?"*
   - **coach** "When I'm working I'm in Overleaf writing chapter 3" → `detail_added` `{kind: "on_track", text: "Writing chapter 3 in Overleaf"}` (brief allows on_track or action).
   - Extra (bonus): coach on "Honestly, this matters because I'm the first in my family to get a degree" → `detail_added` `{kind: "motivation", text: "First in my family to get a degree"}` and the still-empty `why` was auto-filled with that text (the `index.ts` motivation→why rule, verified end to end).
   - Marked ready via the model (`updateGoalDetails` success + `addMilestone`) → `status: 'ready'`, all 4 details kept.
   - **Focus check #1** — jimp-drawn JPEG reading "Overleaf - thesis.tex - Chapter 3: Methods" (+ body lines about evaluating the method):
     `{"verdict":"on_track","confidence":0.97,"reason":"You're writing chapter 3 of your thesis in Overleaf.","nudge":"","roast":"","counted":true,"countedSeconds":60,...}` — on_track, **no roast**.
   - **Focus check #2** — JPEG reading "YouTube - Funny cat compilation #47":
     `{"verdict":"off_track","confidence":0.98,"reason":"You're watching cat compilations on YouTube, your known distraction, with autoplay on.","nudge":"Chapter 3 is waiting in Overleaf — maybe finish this video, then give it ten minutes?","roast":"Compilation #47: officially the longest chapter of your thesis so far.","counted":false,"countedSeconds":0,...}`
     **The roast**: *"Compilation #47: officially the longest chapter of your thesis so far."* — non-empty, PG, ≤ 200 chars, and it ties back to the thesis. Note the reason cites *"your known distraction"*: the `knownDistractions` field from the details graph reached the vision model.
   - Cleanup: test user deleted (`1`), server killed (`taskkill` on the :8791 PID — that's why the background shell reports "exited with code 1", same as the previous briefs), **port 8791 verified free**; 8787/8788 never used.
3. `../CONTRACT.md` updated as listed above.

## Regression verification (extra, beyond the brief)

Temp script (deleted after the run, server still up):

- **Seeded data untouched**: Kenji still 1 goal, 6 milestones, brightness exactly **0.9**, `status: 'ready'`, `missing: []`, and now `details: []` via both `loadGoals` and `GET /api/users/:id` (goal object gains the `details` key without breaking anything else).
- **`addDetail` rules**: invalid kind → null; whitespace-only text → null; case-insensitive duplicate ("  YOUTUBE  " after "YouTube") → null; 150-char text stored as 120; exactly 30 stored, 31st rejected; details sorted by `createdAt`.
- **Cascade**: after `deleteNonSeededUsersByName`, the created `NSDetail` nodes are gone.

## Notes / things that did not work

- **First test run failed 4 checks**: the capture model answered `{"kind":"obstacle","text":"YouTube keeps eating my evenings"}` and dropped the motivation entirely. Cause: the brief's verbatim line says "same kinds **as above**", but the capture prompt never listed the kinds, so the model had no vocabulary and guessed. Fix: one added sentence above the brief's line defining the six kinds (the brief's line itself stays verbatim, and it now literally has kinds "as above"). Second run: exactly `motivation` + `distraction`. LLM output at temperature 0.6 stays mildly non-deterministic, but the vocabulary is now explicit.
- `scripts/accept.ts` still can't run against the isolated test server (it asserts 9 leaderboard rows from the points service, deliberately unreachable on :9) — same reason as in `DONE-capture.md`; the seeded-data and route regressions were covered by the temp script above instead.
- `[points] upsertPlayer failed: fetch failed` warnings during the test are the intended fail-soft path; the focus check still logs locally (`countedSeconds: 60` on the on_track check) and returns `points: null`.
- The vision model (glm-5.3-flash) reads 32–64 px jimp-rendered text without trouble; screenshots are drawn at 800×450 so the base64 stays tiny.
