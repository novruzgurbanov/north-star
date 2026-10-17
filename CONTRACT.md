# North Star: API contract

The frontend (`web/`, Vite on :5173) proxies `/api/*` to the server (`server/`, Express on :8787).
The pal's Electron app calls the same API (CORS open).

## Types

```ts
type Milestone = { id: string; title: string; done: boolean; order: number; brightness: number } // 0..1
type DetailKind = 'subgoal' | 'action' | 'motivation' | 'obstacle' | 'distraction' | 'on_track'
type GoalDetail = { id: string; kind: DetailKind; text: string; createdAt: string } // text max 120 chars, max 30 per goal
type Goal = {
  id: string; title: string; why: string; successLooksLike: string; deadline: string | null;
  status: 'brainstorm' | 'ready'; // ready = successLooksLike non-empty AND milestones.length >= 1
  missing: Array<'success' | 'steps' | 'why'>; // the details still empty, in that order
  brightness: number;            // 0..1; brainstorm stars 0.12 + 0.04 per filled detail, ready goals 0.25+
  createdAt: string;             // ISO
  milestones: Milestone[];       // sorted by order
  details: GoalDetail[];         // small facts recorded by the agent, sorted by createdAt
}
type User = { id: string; name: string; color: string; seeded: boolean }
type Settings = {
  helpfulness: 'quiet' | 'balanced' | 'proactive'  // default 'balanced'
  checkSeconds: number                             // 10..300, default 20 (desktop focus loop)
  strictness: 'relaxed' | 'normal' | 'strict'      // default 'normal'
  roast: 'off' | 'mild' | 'spicy'                  // default 'mild' (always PG)
  notifications: boolean                           // default true (desktop toasts)
  cameraByDefault: boolean                         // default false
  suggestions: boolean                             // default true (reply chips)
  sounds: boolean                                  // default true
  shareGoalTitle: boolean                          // default true (goal title on the shared leaderboard)
}
type Stats = { score: number; streak: number; focusedMinutes: number; milestonesDone: number; starsLit: number }
type ChatMessage = { role: 'user' | 'assistant'; content: string }
type AgentEvent =
  | { type: 'goal_created'; goal: Goal }
  | { type: 'milestone_done'; goalId: string; milestoneId: string }
  | { type: 'milestone_added'; goalId: string; milestone: Milestone }
  | { type: 'focus_logged'; goalId: string; minutes: number }
  | { type: 'details_updated'; goalId: string; goal: Goal }
  | { type: 'detail_added'; goalId: string; detail: GoalDetail }
  | { type: 'goal_ready'; goalId: string }
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok: true, neo4j: boolean, llm: boolean }` |
| POST | `/api/users` | `{ name }` | `{ user }` (upsert by case-insensitive name, non-seeded) |
| GET | `/api/users/:userId` | | `{ user, goals: Goal[], stats: Stats, points: PointsRow \| null, settings: Settings }` (`user.pointsPlayerId` links to the points service) |
| GET | `/api/users/:userId/settings` | | `{ settings: Settings }` (defaults filled in for missing/invalid keys) |
| PUT | `/api/users/:userId/settings` | partial `Settings` | `{ settings: Settings }` (validated, merged, saved; 400 on invalid values, 404 unknown user) |
| POST | `/api/chat` | `{ userId, goalId?: string, messages: ChatMessage[] }` | `{ reply, understanding, phase, events: AgentEvent[], goals: Goal[], stats: Stats, suggestions: string[] }` (2–3 tappable replies, recommended first) |
| POST | `/api/milestones/:id/toggle` | `{ userId }` | `{ goal, stats }` |
| POST | `/api/activity` | `{ userId, goalId?: string, onTask: boolean, minutes: number, source?: string }` | `{ goal, stats }` |
| POST | `/api/users/:userId/active-goal` | `{ goalId }` | `{ ok, points: PointsRow \| null }`; shares that goal's title with the cosmos |
| POST | `/api/focus/check` | `{ userId, goalId, screen, camera?, sinceSeconds }` (base64 JPEGs) | `{ verdict, confidence, reason, nudge, roast, notifyAbove, counted, countedSeconds, goal, stats, points }`; on track with confidence ≥ the `strictness` count threshold logs `sinceSeconds` locally and reports the interval to the points service |
| POST | `/api/transcribe` | raw 16 kHz mono Float32 PCM | `{ text, ms, seconds }` (local Whisper) |
| GET | `/api/cosmos` | | `{ players: PointsRow[], offline }` from the shared points service |
| GET | `/api/leaderboard` | | `{ rows: PointsRow[], offline }` from the shared points service |

- `phase` is `'discovering'` (no `goalId`: the agent captures a new goal in one message) or `'coaching'` (`goalId` given: the agent coaches that goal and helps its details grow).
- `understanding` is 0..1. With no `goalId`, a message that names a goal creates a `brainstorm` star immediately and returns `goal_created` (understanding = 1); small talk returns no event (understanding = 0). In coaching it is always 1.
- In coaching the agent records what the user tells it: `set_details` becomes a `details_updated` event (carrying the fresh goal), and when a goal goes from `brainstorm` to `ready` it also emits `goal_ready`. Details (why, success, steps, deadline) are optional and can be added any time, one light question at a time.
- The coach also records small facts (`DetailKind`: why it matters, what is in the way, what distracts them, sub-goals, concrete actions, what working looks like on screen) as `detail_added` events, max 120 chars, 30 per goal, no exact duplicates; a recorded `motivation` also fills an empty `why`.
- `/api/focus/check` returns `roast` too: one playful line teasing the off-track activity (PG, never about the person), non-empty only when `verdict` is `off_track` and the user's `roast` setting is not `off`.
- `Settings` are per-user and applied by the server: `strictness` sets the focus-check count threshold (confidence ≥ relaxed 0.5 · normal 0.6 · strict 0.75) and `notifyAbove` in the response (relaxed 0.85 · normal 0.7 · strict 0.6) tells the desktop when to notify on off-track. `helpfulness` styles the capture/coach replies; `roast` `off` forces `roast` to `""`, `mild` keeps the gentle teasing, `spicy` makes it sharper (still PG). When `shareGoalTitle` turns false the points player's `goalTitle` is cleared immediately, and while it is false no goal title is ever sent to the points service.
- `/api/activity` is the integration point for the camera/screen tracker. `onTask: false` minutes are stored but earn nothing. If `goalId` is missing, use the user's most recent goal.

`PointsRow` is the `Row` type in [POINTS.md](POINTS.md). Leaderboard points count only verified focus time; the local score below still drives star brightness.

## Scoring

- `focusedMinutes` = sum of on-task activity minutes (from `/api/activity` and `focus_logged`).
- `streak` = consecutive days, ending today or yesterday, with any on-task activity or milestone completion.
- `score = focusedMinutes + 100 * milestonesDone + 25 * streak`.
- Milestone brightness: `done ? 1 : 0.18`.
- Goal brightness: brainstorm stars `0.12 + 0.04 * (filled details among why, successLooksLike, deadline, >=1 milestone)`; ready goals `min(1, 0.25 + 0.6 * doneFraction + min(0.15, focusedMinutes_on_goal / 60 * 0.03))`.
- `starsLit` = goals + done milestones.
