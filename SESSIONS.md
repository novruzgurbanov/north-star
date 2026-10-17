# Focus sessions: plan, focus, recap

The core loop of North Star, on every ready star:

1. **Next up**: the AI proposes one concrete task for right now with a duration.
2. **Focus**: a timed session on that task; the desktop app verifies screen (and optional camera) every check.
3. **Recap**: when time is up (or the user ends it), the AI reads what happened and writes a short, honest recap plus the next task. The session is saved on the goal.

## Server

### `POST /api/goals/:goalId/next-step`  body `{ userId }`
Returns `{ task: string, minutes: 15 | 25 | 50 | 90, why: string, milestoneId: string | null }`.
- `task`: one concrete thing doable now, max 10 words, starts with a verb.
- `minutes`: a realistic duration from that set.
- `why`: one short sentence linking it to the goal.
- `milestoneId`: the undone milestone it advances, if any.

### `POST /api/sessions/recap`
Body:
```ts
{ userId: string, goalId: string, task: string, plannedMinutes: number,
  activeSeconds: number, verifiedSeconds: number, completed: boolean,
  checks: { at: string, verdict: 'on_track' | 'off_track' | 'uncertain', reason: string }[] }  // max 200
```
Returns:
```ts
{ session: Session, headline: string, summary: string, driftNote: string,
  next: { task: string, minutes: number }, suggestMilestoneId: string | null }
```
- `headline`: max 8 words. `summary`: 1-2 sentences, second person, honest and warm (credit what was verified, no invented progress). `driftNote`: one sentence about the drift pattern if there were off-track checks, else "".
- `suggestMilestoneId`: the milestone this task completed, only when verified time is at least 70% of planned and the task clearly matches it; else null.
- Saves `(:NSGoal)-[:HAD_SESSION]->(:NSSession {id, task, plannedMinutes, activeSeconds, verifiedSeconds, drifts, headline, endedAt})`.

### Goal shape
`Goal.sessions: Session[]`: the 5 most recent, newest first.
```ts
type Session = { id: string; task: string; plannedMinutes: number; activeSeconds: number;
  verifiedSeconds: number; drifts: number; headline: string; endedAt: string }
```

## Desktop bridge additions

- `focus.start({ userId, goalId, goalTitle, camera, task?, plannedMinutes? })`: `task` max 120 chars, `plannedMinutes` integer 5..180.
- `FocusState` gains:
  - `task: string | null`, `plannedMinutes: number | null`
  - `activeSeconds: number`: active (not paused) seconds banked before the current stretch
  - `activeSince: string | null`: ISO start of the current active stretch (null while paused/idle). Live elapsed = `activeSeconds + (now - activeSince)`.
  - `history: { at, verdict, confidence, reason, counted, countedSeconds }[]`: this session's checks (max 200)
  - `lastSession: { goalId, goalTitle, task, plannedMinutes, activeSeconds, verifiedSeconds, history, completed, endedAt } | null`: set when a session ends, either automatically when active time reaches `plannedMinutes` (`completed: true`) or by `stop()` (`completed: false`). Cleared by the next `start()`.
