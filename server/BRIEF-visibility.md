# Brief: per-goal visibility, user color, and publishing public goals

Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server` (plus the `../CONTRACT.md` edit). Read `../CONTRACT.md`, `../POINTS.md` (new "Shared goals" section and `PUT /v1/players/:id/goals`, being built right now by another agent) and `src/` first. Keep everything else working. Never print `.env`. No git commits. Do NOT use ports 8787/8788; test with `API_PORT=8794` and `POINTS_URL=http://localhost:9` (points calls fail soft), server in the background, stopped at the end.

## 1. Per-goal visibility
- `NSGoal.public` (boolean). `Goal` gains `public: boolean`; missing → treat as `true`.
- New goals get `public = settings.shareGoalTitle` (the existing "share my goals" setting now means "new goals are public by default").
- `PATCH /api/goals/:goalId` body `{ userId, public: boolean }` → `{ goal }` (404 if not theirs).

## 2. User color
- `PATCH /api/users/:userId` body `{ color }` (`^#[0-9a-fA-F]{6}$`) → `{ user }`; also update the points player's color (fail soft, `PATCH /v1/players/:id {color}`).

## 3. Publish public goals to the points service
- `points.ts`: `publishGoals(playerId, goals: PublicGoal[])` → `PUT /v1/players/:id/goals` (fail soft).
- `syncPublicGoals(userId)` in index.ts or a small module: loads the user's goals, maps the public ones (max 12, newest last) to `{ id, title, status, brightness, milestonesDone, milestonesTotal }`, and publishes them via `ensurePlayer`. Call it (fire and forget, never blocking or failing the response) after: goal created, details updated, milestone toggled/completed/added, goal visibility changed, a session recap saved, and on `GET /api/users/:userId` at most once per 60 s per user (in-memory timestamp) so existing users get synced.
- Keep the legacy single `goalTitle` behaviour working (it is still shown in the leaderboard), but when a goal is private never send its title anywhere.

## Acceptance
1. `npx tsc --noEmit`.
2. `scripts/visibility-test.ts` (user `Zz Visibility Test`, background server on 8794): new goal is public by default; PATCH to private returns `public: false` and persists; PATCH color with a valid hex returns the user with the new color, an invalid one → 400; with a tiny stub points server on port 8797 (run the API with `POINTS_URL=http://localhost:8797` for this part) verify `PUT /v1/players/:id/goals` is called with only the public goals after a visibility change. Delete the user, stop servers, ports free.
3. Update `../CONTRACT.md`.

Write `DONE-visibility.md` with the results.
