# Shared points service: API

One small service that every app (North Star on Windows, Goal Coach on macOS, …) reports **verified focus time** to. It holds only players and focus intervals, and computes points and the leaderboard. Each app keeps its own goals, chats and graphs.

- Runs on one laptop on port **8788**, exposed to the other laptop through a tunnel URL.
- Every request except `GET /v1/health` needs the header `x-points-key: <shared key>` (from the service's `.env`). Never commit the key.
- JSON in and out. Times are ISO 8601 UTC strings. Errors are `{ "error": string }` with a 4xx/5xx status.

## Types

```ts
type Player = {
  id: string            // stable, server-generated
  name: string          // display name, unique case-insensitively
  color: string         // hex, e.g. "#9effd8"
  goalTitle: string | null   // the one public line about what they are working on
  createdAt: string
}

type Row = Player & {
  rank: number              // 1-based, ties share a rank
  points: number            // focusedMinutes + 25 * streak
  focusedMinutes: number    // union of all verified intervals, rounded down to whole minutes
  todayMinutes: number      // same, for the current local day of the server
  streak: number            // consecutive days (ending today or yesterday) with >= 1 verified minute
  lastActiveAt: string | null   // end of the latest interval
  live: boolean             // an interval ended within the last 2 minutes
  sources: string[]         // apps that reported for this player, e.g. ["north-star","goal-coach"]
}
```

## Shared goals

Each player can publish the goals they choose to make public. In the Cosmos every public goal is one star; a player's stars together are their constellation.

```ts
type PublicGoal = {
  id: string            // the app's own goal id (unique per player)
  title: string         // max 80 chars
  status: 'brainstorm' | 'ready'
  brightness: number    // 0..1
  milestonesDone: number
  milestonesTotal: number
}
```

`Row` gains `goals: PublicGoal[]` (in the order they were published).

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/health` | | `{ ok: true }` (no key needed) |
| POST | `/v1/players` | `{ name, color?, goalTitle? }` | `{ player }`. Upsert by case-insensitive name: the same name from two apps is the same player. Updates color/goalTitle when given. |
| PATCH | `/v1/players/:id` | `{ goalTitle?: string \| null, color?: string }` | `{ player }` |
| GET | `/v1/players/:id` | | `{ row }` |
| POST | `/v1/focus` | `{ id, playerId, source, start, end, goalTitle? }` | `{ row }` (the player's fresh stats) |
| PUT | `/v1/players/:id/goals` | `{ goals: PublicGoal[] }` (max 12) | `{ row }`. Replaces the player's whole public goal list; an empty list makes them all private. |
| GET | `/v1/leaderboard` | | `{ rows: Row[] }`, sorted by points desc, then name |

### `POST /v1/focus` rules

- `id` is a client-generated unique id (for example a UUID). Re-sending the same `id` is a no-op, so retries are safe.
- `source` is a short app name (`north-star`, `goal-coach`).
- Send an interval only for time the app **verified** as on task. `end - start` must be between 5 seconds and 15 minutes; `end` may not be more than 60 s in the future, and `start` may not be older than 48 h.
- Overlapping intervals (for example both apps watching the same person at once) are merged, so each minute counts once.
- If `goalTitle` is given, the player's public goal title is updated too.

### Suggested client pattern

Run a check every 20–60 s. When a check says on task, report `[previousCheckTime, now]` as one interval. When it says off task or unsure, report nothing.

## Snippet for Goal Coach (Electron main process)

```ts
import { randomUUID } from 'node:crypto'

const POINTS_URL = process.env.POINTS_URL!   // the tunnel URL you were given
const POINTS_KEY = process.env.POINTS_KEY!   // shared key, keep it in .env

async function points(path: string, body?: unknown) {
  const res = await fetch(`${POINTS_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-points-key': POINTS_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`points ${res.status}`)
  return res.json()
}

// Once, when the user picks a name and a goal:
const { player } = await points('/v1/players', { name: 'Kenji', goalTitle: 'Run a half marathon' })

// After every focus check that says on track:
let lastCheck = Date.now()
async function onCheck(verdict: 'on_track' | 'off_track' | 'uncertain') {
  const now = Date.now()
  if (verdict === 'on_track') {
    await points('/v1/focus', {
      id: randomUUID(), playerId: player.id, source: 'goal-coach',
      start: new Date(lastCheck).toISOString(), end: new Date(now).toISOString(),
    }).catch(() => {})   // never block the focus loop on the leaderboard
  }
  lastCheck = now
}

// Leaderboard for your UI:
const { rows } = await points('/v1/leaderboard')
```
