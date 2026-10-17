# Brief: 20-second checks and roast notifications

Update the existing Electron shell in this folder (`C:\Users\nowru\Documents\assistant\hackathon\north-star\desktop`). Read `../DESKTOP.md` first; it now specifies the new fields. Work ONLY inside this folder. No git repo; do not commit. **Do not launch Electron** (the user has the app open; the maintainer will run the GUI self-test). Only run `node --check` and `node --test test/`.

## Changes

1. **Interval:** `CHECK_SECONDS` default **20** (min 10) in `main.mjs`, and the default in `focus.mjs`.
2. **Notification policy** (`focus.mjs`): replace "two off-track checks in a row + 2-minute cooldown" with: every check whose verdict is `off_track` with confidence ≥ 0.7 notifies, at most once per `NOTIFY_COOLDOWN_SECONDS` (env, default **20**, min 5; pass it in from `main.mjs`). The body is `roast` if non-empty, else `nudge`, else `"Your star is waiting. Back to {goalTitle}?"`.
3. **Roast passthrough:** `FocusCheck` gains `roast` (string from the API response; validate as a string, trim, max 200 chars, `""` otherwise).
4. **Notification health, like the teammate's app** (`main.mjs` + state): add `notice: string | null` to the state (initially null, included in every pushed state).
   - `Notification.isSupported()` false → `notice = "Windows notifications aren't available, so roasts will only show in the app."`
   - A notification's `failed` event → `notice = "Windows is blocking North Star notifications. Turn them on in Settings > System > Notifications."`
   - Its `show` event → `notice = null`.
   Keep a reference to each live notification until it closes or fails (so it is not garbage-collected before it shows), drop it on `close`/`failed`, and close remaining ones on app quit. Notification errors must never fail a focus check. Clicking a notification still focuses the window.
   Title: `"North Star"`. Keep `silent: false`.
5. **Tests** (`test/focus.test.mjs`): update the old notification tests to the new policy and add: a single confident off-track check notifies with the roast; a second one within 20 s does not; one after 20 s does; low-confidence off-track does not notify; roast falls back to nudge, then to the default text; the default interval is 20 s. Keep all other tests passing.
6. Update `scripts/selftest.mjs` only if its expectations depend on the old policy (it must still pass; the mock may include a `roast` string in its off-track response).

## Acceptance

- `node --check main.mjs focus.mjs preload.cjs capture.js capture-preload.cjs scripts/selftest.mjs`
- `node --test test/` all green.

Write `DONE-roast.md` here: what changed and the test results.
