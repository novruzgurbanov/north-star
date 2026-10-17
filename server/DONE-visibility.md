# DONE — per-goal visibility, user color, and publishing public goals

Implements `BRIEF-visibility.md` exactly. All work is inside `server/` plus the allowed `../CONTRACT.md` edit (POINTS.md, `points/` and `web/` changes in the repo belong to the other agents). `.env` values never printed; no git commits; ports 8787/8788 never used — the test ran the API on **8794** (phase 1 with `POINTS_URL=http://localhost:9`, phase 2 against a stub points service on **8797**); every server the test started was stopped again and both ports verified free.

## What was built

| File | Change |
|---|---|
| `src/types.ts` | `Goal` gains `public: boolean` (public goals are published to the cosmos; missing stored value → true). `NewGoal` gains optional `public?: boolean` |
| `src/model.ts` | `toGoal` maps `public` (`g.public == null → true`, so older/seeded goals stay public). `createGoal` stores `public` (`def.public ?? true`). New `setGoalPublic(userId, goalId, isPublic)` (scoped by `PURSUES`, returns the fresh goal, `null` when it is not the user's → 404). New `setUserColor(userId, color)` |
| `src/points.ts` | New `PublicGoal` interface (exact POINTS.md "Shared goals" shape). New `publishGoals(playerId, goals)` → `PUT /v1/players/:id/goals` with `goals.slice(0, 12)` (fail soft via the existing `call`). New `setPlayerColor(playerId, color)` → `PATCH /v1/players/:id {color}` (fail soft) |
| `src/index.ts` | `syncPublicGoals(userId)`: loads the goals, keeps the public ones (max 12 via `.slice(-12)` on the createdAt-ascending load, so newest last), maps to `{ id, title (≤80), status, brightness (2dp), milestonesDone, milestonesTotal }`, ensures the points player, publishes — wrapped in try/catch + callers use `void`, so it never blocks or fails a response. Fired (fire and forget) after: goal created (chat capture), details updated / milestone completed / milestone added (coaching actions), milestone toggled (`/api/milestones/:id/toggle`), goal visibility changed, session recap saved, and on `GET /api/users/:userId` at most once per 60 s per user (in-memory `lastPublicSyncAt` map). New `PATCH /api/users/:userId` `{ color }` (zod `^#[0-9a-fA-F]{6}$` → 400 otherwise) → `{ user }` + fail-soft points player color update (upsert carries the new color when the user had no player yet). New `PATCH /api/goals/:goalId` `{ userId, public }` → `{ goal }`, 404 unknown user/goal, syncs public goals, and when a goal turns private `clearLegacyTitle` drops the player's legacy `goalTitle` if it is that goal's title (fail soft). Chat capture creates goals with `public: settings.shareGoalTitle`. Legacy single `goalTitle` behaviour kept in chat capture / `active-goal` / `focus/check` but now gated by `settings.shareGoalTitle && goal.public` — a private goal's title is never sent anywhere |
| `scripts/visibility-test.ts` | New self-contained acceptance script: starts a stub points service on :8797 (records every `PUT /v1/players/:id/goals` and player PATCH, echoes `goalTitle`/`color` back on GET), spawns the API server itself via `node --import tsx src/index.ts` (phase 1: `API_PORT=8794 POINTS_URL=http://localhost:9`; phase 2: restarted with `POINTS_URL=http://localhost:8797`), runs 30 checks across both phases, deletes the throwaway users by name through the model, kills the server, closes the stub, and re-verifies both ports are free |
| `../CONTRACT.md` | `Goal` gains `public: boolean`; `Settings.shareGoalTitle` comment now reads "new goals are public by default…"; `PATCH /api/users/:userId` and `PATCH /api/goals/:goalId` rows in the Endpoints table; new bullet documenting the publishing triggers (incl. the 60 s GET throttle, max 12 newest last, the PublicGoal shape) and the private-title rule |

## Acceptance checks (all run)

1. `npx tsc --noEmit` — **passes** (run after the src changes, after adding the script, and again at the end).
2. `npx tsx scripts/visibility-test.ts` — **all 30 checks passed** (user `Zz Visibility Test`, second user `Zz Visibility Test Two` for the throttle check; both deleted; API on 8794, stub on 8797; 8787/8788 untouched):

   **Phase 1 — points unreachable (`POINTS_URL=http://localhost:9`), fail soft:**
   - Goal created via chat → **`public: true` by default**; `GET /api/users/:id` shows the same.
   - **`PATCH /api/goals/:goalId { userId, public: false }`** → 200, `goal.public === false`, and still `false` on the next GET (persisted).
   - PATCH visibility of an unknown goal → **404**.
   - `shareGoalTitle: false` → the next chat-created goal is born **`public: false`**; setting turned back on afterwards.
   - **`PATCH /api/users/:userId { color: '#12abEF' }`** → 200, user returned with the new color, persisted on GET; `{ color: 'red' }` and `{ color: '#12abE' }` → **400** each.
   - All of this with the points service dead — only `[points] … failed: fetch failed` warnings, every route still 200/400 as expected.

   **Phase 2 — stub points service on 8797 (`POINTS_URL=http://localhost:8797`):**
   - First `GET /api/users/:id` for the existing user fired a sync: **`PUT /v1/players/stub-player-1/goals` called with `[]`** (its only goal is private) — proving existing users get synced and only public goals are sent.
   - Two more goals via chat (both public by default), then **`PATCH` goal 4 to private** → the stub received a PUT whose goal list is **exactly `[goal3]`** (`{"id":"rDV2W6rvnOKs","title":"Run a half marathon in spring","status":"brainstorm","brightness":0.16,"milestonesDone":0,"milestonesTotal":0}`) — the exact `PublicGoal` shape from POINTS.md.
   - The private-from-birth goals (goal 1, goal 2) appear in **no** published list ever; goal 4 is never published again after going private.
   - `PATCH color '#00ff00'` → the stub recorded `PATCH /v1/players/:id {"color":"#00ff00"}` (fail-soft points player update), and `{"goalTitle":null}` arrived too — the legacy leaderboard title was cleared because its goal had just gone private.
   - Throttle: the second user's first `GET /api/users/:id` triggers exactly one sync; two more GETs within 60 s trigger **0** extra PUTs.
   - Cleanup: both test users deleted (`2`), API child killed, stub closed, **ports 8794 and 8797 verified free again**.

3. `../CONTRACT.md` updated as listed above.

## Server log evidence (excerpt from the run)

```
PHASE 1 — API on :8794, POINTS_URL=http://localhost:9 (fail soft)
  ok   chat-created goal is public by default (true)
  ok   PATCH returns public:false (false)
  ok   new goal private while shareGoalTitle is off (false)
  ok   valid hex -> user returned with the new color ("#12abEF")
  ok   invalid color "red" -> 400 (400)
[points] upsertPlayer failed: fetch failed        <- intended fail-soft path

PHASE 2 — API on :8794, POINTS_URL=http://localhost:8797 (stub)
  ok   no public goals yet -> empty list ([])
  ok   PUT carries exactly the still-public goal ([["rDV2W6rvnOKs"]])
  ok   PublicGoal shape { id, title, status, brightness, milestonesDone, milestonesTotal }
  ok   points player color updated via PATCH /v1/players/:id ([{"goalTitle":"Run a half marathon in spring"},{"goalTitle":"Build a wooden birdhouse this winter"},{"goalTitle":null},{"color":"#00ff00"}])
  ok   GETs within 60 s do not sync again (0 extra call(s))
  ok   test users deleted (2)
  ok   port 8794 free again
  ok   port 8797 free again
all visibility acceptance checks passed
```

## Notes

- The sync is a strict superset-free implementation of the brief's trigger list: goal created, details updated (`details_updated`), milestone toggled/completed/added, visibility changed, session recap saved, plus the 60 s-throttled GET. `focus_logged` and plain `detail_added` are deliberately not triggers (they are not in the brief; brightness drift is self-corrected by the throttled GET sync).
- Max 12 goals keeps the **newest** twelve: `loadGoals` returns goals oldest-first, so `.filter(public).slice(-12)` publishes the newest 12 with the newest last, per the brief.
- When a goal turns private, `clearLegacyTitle` compares the player's current `goalTitle` with that goal's title and clears it only on a match — a different public goal's title is never wiped. Turning a goal public again does not restore a title; the public-goals list is the source of truth for the cosmos.
- The brightness published is rounded to 2 decimals; `title` is sliced to 80 chars (POINTS.md cap) though `createGoal`/`updateGoalDetails` already cap titles at 80.
- `PATCH /api/users/:userId` also creates the points player when the user had none yet — the upsert already carries the new color, and the explicit `PATCH /v1/players/:id {color}` covers the existing-player case.
- The `[api] [api]` doubled prefixes in the raw log are just the child process's multi-line stdout chunks being prefixed once per chunk by the test harness; the server itself logs normally.
