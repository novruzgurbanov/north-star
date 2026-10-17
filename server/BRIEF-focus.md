# Brief: verified focus checks + shared points sync

The North Star backend (this folder) already works: goals, chat agent, Whisper. Read `../CONTRACT.md` (current API), `../POINTS.md` (the shared points service another agent is building right now on port 8788), and the existing code in `src/` before changing anything. Keep every existing route working; only extend.

Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server`. Never print or log `.env` values or image data. No git repo; do not commit.

## Why

A Windows desktop shell (being built separately) takes a screenshot and a webcam frame every ~30 s while the user focuses on a goal, and sends them to **this server**. The server asks a vision model whether the user is on task. Verified minutes brighten the user's stars locally **and** are reported to the shared points service, which powers a multiplayer leaderboard shared with a teammate's macOS app. Only verified time earns points.

`.env` now also has `POINTS_URL` (default `http://localhost:8788`) and `POINTS_KEY` (send as header `x-points-key`). Vision model: `process.env.VISION_MODEL || 'zai-org/glm-5.3-flash'` (it accepts OpenAI-style `image_url` parts with `data:image/jpeg;base64,...`).

## 1. `src/points.ts`: points client

`upsertPlayer({name,color,goalTitle?})`, `patchPlayer(id, {goalTitle})`, `reportFocus({id, playerId, source:'north-star', start, end, goalTitle})`, `getRow(playerId)`, `leaderboard()`. Use `fetch` with a 4 s timeout (AbortController). Never throw into a request handler for points failures: log one short line (`[points] <op> failed: <status or message>`) and return `null`, so the app keeps working offline.

## 2. Linking users to players

- Add `pointsPlayerId` to `NSUser`. On `POST /api/users`, upsert a points player with the same name and color and store its id. For existing users without one, link lazily (helper `ensurePlayer(user)`) whenever it's needed.
- `GET /api/users/:userId` additionally returns `points: Row | null` (the player's row from the service) and `user.pointsPlayerId`.
- New `POST /api/users/:userId/active-goal` `{ goalId }` → sets the player's public `goalTitle` to that goal's title, returns `{ ok: true, points: Row | null }`. Also set it automatically when `/api/chat` creates a goal (`goal_created`).

## 3. `POST /api/focus/check` (the core)

Raise the global `express.json` limit to `8mb` (screens arrive as base64 JPEG). Body (zod):

```ts
{ userId: string, goalId: string,
  screen: string,            // base64 JPEG, with or without a "data:image/jpeg;base64," prefix
  camera?: string | null,    // same, optional
  sinceSeconds: number }     // seconds since the previous check, 5..900
```

Steps: load user + goal (404 if missing / not theirs) → call the vision model with the system prompt below, the goal JSON (title, why, successLooksLike, next undone milestone title), and the image(s) as `image_url` parts → parse JSON like `agent.ts` does (reuse its JSON extraction; one retry; on failure return verdict `uncertain`, confidence 0, reason "Couldn't check this time.").

If `verdict === 'on_track' && confidence >= 0.6`:
- log local activity for the goal: `minutes = sinceSeconds / 60` **as a fractional number** (do not round up to 1; add a separate model function if `logActivity` clamps), `onTask: true`, `source: 'desktop'`
- report `{ id: nanoid(), playerId, source: 'north-star', start: now - sinceSeconds, end: now, goalTitle: goal.title }` to the points service.

Response:
```ts
{ verdict: 'on_track'|'off_track'|'uncertain', confidence: number, reason: string, nudge: string,
  counted: boolean, countedSeconds: number, goal: Goal, stats: Stats, points: Row | null }
```
Images are used only in memory for this one call. Never store, log or echo them.

Vision system prompt (use verbatim, fill the placeholders):

```
You check whether a person is working on their goal right now, from a screenshot of their screen and, if present, a webcam photo.
Goal: {GOAL_JSON}

Judge only what is visible.
- on_track: the main thing on screen plausibly serves the goal (relevant documents, code, tools, research, learning material, writing), or the webcam shows them doing an offline activity tied to the goal (practising the instrument, reading, studying on paper, training).
- off_track: clearly unrelated entertainment, social feeds, shopping or games as the main activity, or nobody at the desk with nothing relevant happening.
- uncertain: anything you cannot judge fairly.
Be fair: a chat or music app in a corner is fine when the main window is work. Do not describe the person's appearance and do not quote private content from the screen.

Respond with ONLY a JSON object:
{"verdict": "on_track" | "off_track" | "uncertain", "confidence": number 0-1,
 "reason": string (max 14 words, second person, e.g. "You're editing your thesis draft in Word."),
 "nudge": string (one kind sentence to bring them back, only when off_track, else "")}
```

## 4. Shared leaderboard

- `GET /api/leaderboard` → `{ rows: Row[], offline: boolean }` from the points service (`offline: true` and `rows: []` when it is unreachable).
- `GET /api/cosmos` → `{ players: Row[], offline: boolean }` (same data; the frontend draws a star per player).
- Leave the old local seed and local stats code in place (stars still use local stats), but these two routes now come from the points service.

## 5. Update `../CONTRACT.md`

Edit only the endpoint table and types in `../CONTRACT.md` to document the new and changed routes. That file is the one exception to "only this folder".

## Acceptance checks

1. `npx tsc --noEmit` passes.
2. Another agent is building and testing the real points service on port 8788 right now, so do NOT bind 8788 and do not touch `../points`. Write a tiny in-memory stub `scripts/points-stub.ts` implementing the POINTS.md routes (including the `x-points-key` check against `POINTS_KEY`) on port **8798**, and run this server for your tests with the environment variable `POINTS_URL=http://localhost:8798` set in the shell (dotenv does not override variables already set).
3. Make a test screenshot: `scripts/focus-test.ts` builds a simple JPEG (for example render text such as "main.py - Visual Studio Code: def train_model()" onto an image; you may `npm i -D` a small image library like `jimp` or `@napi-rs/canvas` for the script only), creates a test user + goal directly through the model functions ("Get my first ML internship", milestones), calls `POST /api/focus/check` with `sinceSeconds: 30`, and prints the response. Expect `on_track` with `counted: true`, local stats focusedMinutes up by 0.5, and the points row increased. Then send an image of something clearly unrelated (for example text "YouTube - Funny cat compilation #47") and expect `off_track` with a nudge and `counted: false`.
4. Check `/api/leaderboard` and `/api/cosmos` return points rows; check that with the points service stopped they return `offline: true` and the focus check still answers (`points: null`).
5. Delete your test user and goal afterwards; stop any servers you started; ports 8787 and 8798 free.

Write `DONE-focus.md` here with what you built, the verdicts and timings you observed, and anything that did not work.

## 6. Suggested answers (do this too)

The chat UI will show 2–3 tappable suggested replies under each agent message (the first one marked as recommended) plus its own "Something else…" chip. Extend the agent:

- In `src/agent.ts`, append these lines to BOTH system prompts (discover and coach), just before their "Respond with ONLY a JSON object" line:

```
Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.
```

- Add `"suggestions": string[]` to both JSON shapes in the prompts.
- Parse it defensively: keep only non-empty strings, trim, cap each at 80 characters, keep at most 3, drop duplicates (case-insensitive). On fallback replies return `[]`.
- `POST /api/chat` returns `suggestions: string[]` alongside the existing fields. Document it in `../CONTRACT.md`.
- Acceptance: one discover turn and one coach turn each return 2–3 sensible suggestions (print them in DONE-focus.md).
