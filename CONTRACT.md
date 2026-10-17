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
  public: boolean;               // public goals are published to the cosmos; missing stored value -> true
  missing: Array<'success' | 'steps' | 'why'>; // the details still empty, in that order
  brightness: number;            // 0..1; brainstorm stars 0.12 + 0.04 per filled detail, ready goals 0.25+
  createdAt: string;             // ISO
  milestones: Milestone[];       // sorted by order
  details: GoalDetail[];         // small facts recorded by the agent, sorted by createdAt
  sessions: Session[];           // the 5 most recent focus sessions, newest first
  panel: PanelSpec | null;       // v2: the AI-built panel, null until designed (PANELS.md)
  entries: Entry[];              // v2: what the user logged in the panel's log widgets, newest first, max 400, last 400 days (PANELS.md)
}
type Session = { id: string; task: string; plannedMinutes: number; activeSeconds: number;
  verifiedSeconds: number; drifts: number; headline: string; endedAt: string } // drifts = off_track checks in the session
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
  shareGoalTitle: boolean                          // default true (new goals are public by default; the active goal's title still shows on the leaderboard)
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
  | { type: 'entry_logged'; goalId: string; entry: Entry }                    // v2 (PANELS.md)
  | { type: 'panel_updated'; goalId: string; goal: Goal; change: string }     // v2 (PANELS.md)
```

`PanelSpec`, `Widget`, `Field` and `Entry` are defined in [PANELS.md](PANELS.md).

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok: true, neo4j: boolean, llm: boolean }` |
| POST | `/api/users` | `{ name }` | `{ user }` (upsert by case-insensitive name, non-seeded) |
| GET | `/api/users/:userId` | | `{ user, goals: Goal[], stats: Stats, points: PointsRow \| null, settings: Settings }` (`user.pointsPlayerId` links to the points service) |
| GET | `/api/users/:userId/settings` | | `{ settings: Settings }` (defaults filled in for missing/invalid keys) |
| PUT | `/api/users/:userId/settings` | partial `Settings` | `{ settings: Settings }` (validated, merged, saved; 400 on invalid values, 404 unknown user) |
| PATCH | `/api/users/:userId` | `{ color }` (hex `^#[0-9a-fA-F]{6}$`) | `{ user }`; also updates the points player's color (fail soft) |
| POST | `/api/chat` | `{ userId, goalId?: string, messages: ChatMessage[] }` | `{ reply, understanding, phase, events: AgentEvent[], goals: Goal[], stats: Stats, suggestions: string[] }` (2–3 tappable replies, recommended first) |
| POST | `/api/milestones/:id/toggle` | `{ userId }` | `{ goal, stats }` |
| POST | `/api/activity` | `{ userId, goalId?: string, onTask: boolean, minutes: number, source?: string }` | `{ goal, stats }` |
| POST | `/api/users/:userId/active-goal` | `{ goalId }` | `{ ok, points: PointsRow \| null }`; shares that goal's title with the cosmos |
| POST | `/api/focus/check` | `{ userId, goalId, screen, camera?, sinceSeconds }` (base64 JPEGs) | `{ verdict, confidence, reason, nudge, roast, notifyAbove, counted, countedSeconds, goal, stats, points }`; on track with confidence ≥ the `strictness` count threshold logs `sinceSeconds` locally and reports the interval to the points service |
| POST | `/api/goals/:goalId/next-step` | `{ userId }` | `{ task, minutes, why, milestoneId }` — the one task (max 10 words, starts with a verb) to do right now; `minutes` is 15, 25, 50 or 90; `milestoneId` is the undone milestone it advances, if any; 404 for unknown user/goal |
| PATCH | `/api/goals/:goalId` | `{ userId, public }` | `{ goal }` (404 if not theirs); republishes the user's public goals to the cosmos |
| POST | `/api/sessions/recap` | `{ userId, goalId, task (1–120 chars), plannedMinutes (5–180), activeSeconds, verifiedSeconds, completed, checks: { at, verdict, reason (≤200 chars) }[] }` (max 200 checks) | `{ session, headline, summary, driftNote, next: { task, minutes }, suggestMilestoneId }` — saves the session on the goal and writes an honest recap; `suggestMilestoneId` set only when verified time ≥ 70% of planned and the task clearly matches that still-undone milestone; the session is saved even when the AI call fails |
| POST | `/api/goals/:goalId/panel/design` · `/panel/edit` · `/panel/undo` | see [PANELS.md](PANELS.md) | v2: AI-built goal panels (design, edit in words, undo) |
| PATCH | `/api/goals/:goalId/panel/widgets/:widgetId` | `{ userId, op }` | v2: manual remove / move / toggle a checklist item (PANELS.md) |
| POST / DELETE | `/api/goals/:goalId/entries` · `/entries/:entryId` | see [PANELS.md](PANELS.md) | v2: log an entry (optional proof photo judged by the vision model) / delete it |
| POST | `/api/transcribe` | raw 16 kHz mono Float32 PCM | `{ text, ms, seconds }` (local Whisper) |
| GET | `/api/cosmos` | | `{ players: PointsRow[], offline }` from the shared points service |
| GET | `/api/leaderboard` | | `{ rows: PointsRow[], offline }` from the shared points service |

- `phase` is `'discovering'` (no `goalId`: the agent captures a new goal in one message) or `'coaching'` (`goalId` given: the agent coaches that goal and helps its details grow).
- `understanding` is 0..1. With no `goalId`, a message that names a goal creates a `brainstorm` star immediately and returns `goal_created` (understanding = 1); small talk returns no event (understanding = 0). In coaching it is always 1.
- In coaching the agent records what the user tells it: `set_details` becomes a `details_updated` event (carrying the fresh goal), and when a goal goes from `brainstorm` to `ready` it also emits `goal_ready`. Details (why, success, steps, deadline) are optional and can be added any time, one light question at a time.
- The coach also records small facts (`DetailKind`: why it matters, what is in the way, what distracts them, sub-goals, concrete actions, what working looks like on screen) as `detail_added` events, max 120 chars, 30 per goal, no exact duplicates; a recorded `motivation` also fills an empty `why`.
- `/api/focus/check` returns `roast` too: one playful line teasing the off-track activity (PG, never about the person), non-empty only when `verdict` is `off_track` and the user's `roast` setting is not `off`.
- `Settings` are per-user and applied by the server: `strictness` sets the focus-check count threshold (confidence ≥ relaxed 0.5 · normal 0.6 · strict 0.75) and `notifyAbove` in the response (relaxed 0.85 · normal 0.7 · strict 0.6) tells the desktop when to notify on off-track. `helpfulness` styles the capture/coach replies; `roast` `off` forces `roast` to `""`, `mild` keeps the gentle teasing, `spicy` makes it sharper (still PG). When `shareGoalTitle` turns false the points player's `goalTitle` is cleared immediately, and while it is false no goal title is ever sent to the points service.
- Per-goal visibility: every goal is public or private. New goals are public when `shareGoalTitle` is on (the default); `PATCH /api/goals/:goalId` flips one goal. The server publishes the user's public goals to the points service (`PUT /v1/players/:id/goals`, max 12, newest last, shape `{ id, title, status, brightness, milestonesDone, milestonesTotal }` from [POINTS.md](POINTS.md)) after a goal is created, details are updated, a milestone is toggled/completed/added, a goal's visibility changes, a session recap is saved, and on `GET /api/users/:userId` at most once per 60 s per user — always fire and forget, failing soft. A private goal's title is never sent to the points service; the legacy single `goalTitle` (active goal on the leaderboard) keeps working for public goals.
- v2 panels ([PANELS.md](PANELS.md)): every spec, AI-written or not, goes through the server's sanitizer (`server/src/panel.ts`) before it is saved. A verified entry with minutes logs an `NSActivity` (`source: 'checkin'`) and reports its time to the points service in chunks of at most 15 minutes. In coaching the agent may log self-reported entries (`entry_logged`) and change the panel (`panel_updated`).
- `/api/activity` is the integration point for the camera/screen tracker. `onTask: false` minutes are stored but earn nothing. If `goalId` is missing, use the user's most recent goal.
- Focus sessions are the core loop on ready goals: `/api/goals/:goalId/next-step` has the coach pick the next task (it sees the goal's milestones, subgoal/action details and the last 3 sessions, so it never repeats finished work); `/api/sessions/recap` ends a session, saves it on the goal (`Goal.sessions`, newest first, max 5) and returns the recap plus the next task. A session's `drifts` counts its `off_track` checks; `driftNote` names the drift pattern and is `""` when the user never drifted.

`PointsRow` is the `Row` type in [POINTS.md](POINTS.md). Leaderboard points count only verified focus time; the local score below still drives star brightness.

## Scoring

- `focusedMinutes` = sum of on-task activity minutes (from `/api/activity` and `focus_logged`).
- `streak` = consecutive days, ending today or yesterday, with any on-task activity or milestone completion.
- `score = focusedMinutes + 100 * milestonesDone + 25 * streak`.
- Milestone brightness: `done ? 1 : 0.18`.
- Goal brightness: brainstorm stars `0.12 + 0.04 * (filled details among why, successLooksLike, deadline, >=1 milestone)`; ready goals `min(1, 0.25 + 0.6 * doneFraction + min(0.15, focusedMinutes_on_goal / 60 * 0.03))`.
- `starsLit` = goals + done milestones.
