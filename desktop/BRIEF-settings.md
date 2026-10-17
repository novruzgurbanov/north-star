# Brief: configurable check interval and notifications

Update the Electron shell in this folder. Read `../DESKTOP.md` and `../SETTINGS.md` first. Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\desktop`. No git commits. **Never launch Electron**; only run `node --check` and `node --test test/`.

## Changes

1. Bridge: `window.northStarDesktop.focus.configure({ checkSeconds?, notifications? })` in `preload.cjs`, IPC handler in `main.mjs` with validation (`checkSeconds` integer 10..300, `notifications` boolean; ignore malformed fields), returning the state.
2. `focus.mjs`: `configure()` updates `state.checkSeconds` (the next scheduled check uses the new interval; if a check is already scheduled further away than the new interval, reschedule it to fire at `lastCheck + new interval`, never earlier than 1 s from now) and a `notificationsEnabled` flag (add `notificationsEnabled: boolean` to the state, default true). When notifications are disabled, never call `notify`.
3. Notify threshold: use `notifyAbove` from the API response when it is a number between 0 and 1, otherwise 0.7 (replace the fixed 0.7).
4. Tests: configure changes the interval (including rescheduling a pending check), invalid configure args are ignored, notifications disabled → no notify, `notifyAbove` respected (0.6 notifies at 0.65, 0.85 does not at 0.8). Keep all existing tests green.
5. Update the `configure` line in `../DESKTOP.md`? No, it is already documented; do not edit files outside this folder.

## Acceptance

`node --check main.mjs focus.mjs preload.cjs` and `node --test test/` all green. Write `DONE-settings.md` here.
