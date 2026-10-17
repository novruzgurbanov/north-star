# Settings contract

Per-user settings, stored on the server, edited in the web UI's Settings view, and applied by the server (agent and focus judge) and the desktop shell (check loop).

```ts
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
```

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/users/:userId/settings` | | `{ settings }` (defaults filled in for missing keys) |
| PUT | `/api/users/:userId/settings` | partial `Settings` | `{ settings }` (validated, merged, saved) |

`GET /api/users/:userId` also returns `settings`.

## Server behaviour

- **helpfulness**: one extra line appended to the capture and coach system prompts:
  - quiet: `Style: be brief. One short sentence. Do not ask a question unless the user asks for help, and never push for details.`
  - balanced: (nothing extra)
  - proactive: `Style: be an engaged coach. Each reply proposes one concrete next step, and in brainstorm asks one question that moves the goal toward ready.`
- **strictness** (focus check): count on-track time when confidence ≥ `relaxed 0.5 · normal 0.6 · strict 0.75`. The desktop notifies on off-track when confidence ≥ `relaxed 0.85 · normal 0.7 · strict 0.6`; the server returns that threshold as `notifyAbove` in the focus-check response so the desktop doesn't need its own copy.
- **roast**: `off` → instruct the vision model to leave `roast` empty and force `""`; `mild` → current gentle teasing; `spicy` → sharper, more sarcastic teasing, still PG, still never about the person.
- **shareGoalTitle**: false → the points player's `goalTitle` is set to `null` and never updated; true → current behaviour.

## Desktop bridge

`window.northStarDesktop.focus.configure({ checkSeconds, notifications })` → `Promise<FocusState>`. Applies immediately: a new interval takes effect from the next scheduled check; `notifications: false` suppresses toasts (the roast still shows in the app). The web UI calls it on load and whenever settings change.
