# Roast notifications and 20-second checks — done

Implemented per `BRIEF-roast.md` and `../DESKTOP.md`, in this folder only. No dependencies added, no commits, and Electron was never launched.

## What changed

- `focus.mjs`
  - Default `checkSeconds` is now **20** (minimum 10, invalid values fall back to 20).
  - New injected option `notifyCooldownSeconds` (default **20**, minimum 5).
  - New notification policy: **every** check with verdict `off_track` and confidence ≥ 0.7 notifies, at most once per the cooldown window (measured from the last actual notification, so a suppressed check does not delay the next allowed one). The old "two off-track checks in a row + 2-minute cooldown" streak logic was removed.
  - Notification body: `roast` if non-empty, else `nudge`, else `"Your star is waiting. Back to {goalTitle}?"`. Emptiness is judged after trimming, so a whitespace-only roast or nudge falls through to the next option.
  - `FocusCheck` (`lastCheck`) gains `roast`: normalized from the API response — validated as a string, trimmed, capped at 200 chars, `""` otherwise.
  - State gains `notice: string | null` (initially null) and a `setNotice()` method that normalizes blank strings to `null` and pushes state only on change; it is included in every pushed state via `getState()`.
- `main.mjs`
  - `CHECK_SECONDS` default **20** (min 10); new `NOTIFY_COOLDOWN_SECONDS` env (default **20**, min 5), both passed into the controller.
  - Notification health: `Notification.isSupported()` false → `notice = "Windows notifications aren't available, so roasts will only show in the app."`; a notification's `failed` event → `notice = "Windows is blocking North Star notifications. Turn them on in Settings > System > Notifications."`; its `show` event → `notice = null`. Each live notification is kept referenced in the existing set (dropped on `close`/`failed`, still all closed on app quit), errors never fail a focus check, clicking still focuses the window, title `"North Star"`, `silent: false` explicit.
- `scripts/selftest.mjs`: expectations did not depend on the old policy, so only the mock's off-track response gained a `roast` string, exercising the passthrough in the GUI self-test.
- `test/focus.test.mjs`: updated the two old-policy tests and added the required coverage (23 tests total, up from 17).
- `preload.cjs`, `capture.js`, `capture-preload.cjs`, `package.json`: unchanged (state fields flow through the existing bridge).

## Test coverage added

- A single confident off-track check notifies with the roast (confidence 0.7 boundary, and `lastCheck.roast` passthrough).
- A second off-track check within 20 s does not notify; one 20 s after the last notification does, exactly 20 s apart.
- A suppressed check does not push the cooldown back.
- Low-confidence (0.69) off-track never notifies; uncertain and on-track never notify.
- Body falls back roast → nudge → default text (including whitespace-only roast/nudge).
- Cooldown is configurable via `notifyCooldownSeconds`.
- Default interval is 20 s (state field and actual scheduling).
- `setNotice` publishes non-empty notices, normalizes blanks to null, dedupes, and survives stop.

## Acceptance results

- **PASS** `node --check main.mjs focus.mjs preload.cjs capture.js capture-preload.cjs scripts/selftest.mjs` — clean.
- **PASS** `node --test test/` — 23 tests, 23 passed, 0 failed, 0 cancelled.

## Not verified here

Per the brief, Electron was not launched, so the GUI self-test (`npm run selftest`), real Windows toast behavior, `show`/`failed` events, and the on-screen `notice` rendering remain for the maintainer to verify with the app. Note the self-test's second check is now a confident off-track, so it will attempt one real Windows notification.
