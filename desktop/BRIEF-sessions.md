# Brief: timed focus sessions in the desktop shell

Implement the **Desktop bridge additions** in `../SESSIONS.md`. Read it and `../DESKTOP.md` first. Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\desktop`. No git commits. **Never launch Electron**; only `node --check` and `node --test test/`.

## Changes
1. `start()` accepts optional `task` (string, trimmed, max 120) and `plannedMinutes` (integer 5..180); validate in `main.mjs` IPC like the other args. Store both in state; `start()` clears `lastSession` and `history`.
2. Active-time accounting in `focus.mjs`: `activeSeconds` (banked) + `activeSince` (ISO or null). Bank on pause, stop, error and completion; set `activeSince` on start/resume. Paused time never counts.
3. `history`: append every check result of this session (`at, verdict, confidence, reason, counted, countedSeconds`), max 200 (drop oldest).
4. Completion: when `plannedMinutes` is set, schedule a completion timer for the remaining active time (re-arm on resume, cancel on pause/stop). On completion: bank time, set `lastSession` (`goalId, goalTitle, task, plannedMinutes, activeSeconds, verifiedSeconds: sessionVerifiedSeconds, history, completed: true, endedAt`), then end the session exactly like `stop()` (status idle, camera released, no further checks). A check in flight when time is up may finish and be included if it completes within 5 s; otherwise ignore its result.
5. `stop()` while a session is active or paused also sets `lastSession` with `completed: false`.
6. All new fields are in every pushed state (`task`, `plannedMinutes`, `activeSeconds`, `activeSince`, `history`, `lastSession`), with null/0/[] defaults.
7. Tests for: plannedMinutes completion fires at the right active time (excluding a pause), lastSession contents for completed and manual stop, history cap, start clears lastSession, invalid task/plannedMinutes ignored. Keep all existing tests green.

Write `DONE-sessions.md` with the test results.
