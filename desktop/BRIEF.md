# Brief: North Star desktop shell for Windows (Electron)

Build a small Electron app in this folder (`C:\Users\nowru\Documents\assistant\hackathon\north-star\desktop`) that opens the existing North Star web UI and runs **focus verification**: while the user focuses on a goal, it takes a screenshot of the primary screen (and optionally a webcam frame) every 30 s and sends them to the North Star API, which asks a vision model whether the user is on task. Verified time turns into points on a shared multiplayer leaderboard. This is for a hackathon demo on Windows 11 in about 2 hours; favour simple, robust code over features.

Read these first:
- `../DESKTOP.md`: the exact `window.northStarDesktop` bridge and `FocusState` shape the web UI is coded against. Implement it exactly.
- `../CONTRACT.md` and `../server/BRIEF-focus.md`: the `POST /api/focus/check` endpoint you call (another agent is building it right now; you can't rely on it running).

Work ONLY inside this `desktop` folder. Do not edit `../web`, `../server`, `../points`. Electron 44.8.0 is already installed (`node_modules`). Use plain JavaScript (ESM `main.mjs`, CommonJS `preload.cjs`), no bundler and no TypeScript, so it runs with `electron .` directly. Do not commit (there is no git repo). Do not add dependencies unless necessary; if you must, explain why in DONE.md.

## Files

```
main.mjs          app lifecycle, main window, focus loop, IPC, notifications, power events
preload.cjs       contextBridge → window.northStarDesktop (exactly as DESKTOP.md)
capture.html      hidden window that owns the webcam
capture.js        getUserMedia + grab a JPEG frame on request
focus.mjs         pure focus state machine (testable without Electron)
test/focus.test.mjs   node:test unit tests for focus.mjs (fake clock, fake capture, fake API)
scripts/selftest.mjs  see acceptance checks
```

## Main window

- `WEB_URL` env (default `http://localhost:5173`), `API_URL` env (default `http://localhost:8787`), `CHECK_SECONDS` env (default 30, min 10).
- 1440×900, min 960×640, background `#020309`, `show: false` until `ready-to-show`. Title "North Star".
- Dark custom title bar: `titleBarStyle: 'hidden'` with `titleBarOverlay: { color: '#020309', symbolColor: '#c9d4f2', height: 40 }`. (The web UI adds its own drag region and leaves room for the window buttons when it sees `window.northStarDesktop`.)
- Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Allow navigation only within the `WEB_URL` origin; open other links with `shell.openExternal`. Deny all permission requests except `media` from the `WEB_URL` origin (the web UI uses the microphone for voice input) and `media` from the capture window. Validate every IPC argument (types and string lengths); ignore malformed calls.
- If the web UI can't be reached at startup, show a small built-in dark page that says to run `npm run dev` from the `north-star` folder, and retry every 3 s.

## Focus loop (`focus.mjs` + `main.mjs`)

Implement the state machine from DESKTOP.md:

- `start({userId, goalId, goalTitle, camera})` → status `active`, `startedAt` now; first check after **5 s** (so the demo shows feedback quickly), then every `CHECK_SECONDS`. Starting while active switches goal (fresh session).
- Each check: capture the primary display (`desktopCapturer.getSources({ types: ['screen'], thumbnailSize: ~1280×720 scaled to the display aspect })`, pick the source whose `display_id` matches `screen.getPrimaryDisplay().id`, fall back to the first) → `thumbnail.toJPEG(70)` → base64. If the camera is enabled, ask the capture window for a frame (640×360 JPEG, quality 0.7, 3 s timeout; on failure continue without it and set `cameraActive: false`). POST `${API_URL}/api/focus/check` with `{ userId, goalId, screen, camera, sinceSeconds }` where `sinceSeconds` = seconds since the previous check (or since start/resume), clamped to 5..900. Timeout 45 s.
- Update state from the response: `lastCheck` (verdict, confidence, reason, nudge, counted, countedSeconds, `at`), `lastResult` (`goal`, `stats`, `points` passthrough), `sessionVerifiedSeconds += countedSeconds`, `checks += 1`, `nextCheckAt`. Push state to the renderer (`webContents.send`) after every change, and also every 1 s is NOT needed (the renderer counts down itself from `nextCheckAt`).
- Never run two checks at once. Schedule the next check only after the current one finishes.
- Two consecutive `off_track` checks with confidence ≥ 0.7 → native `Notification` (title "North Star", body = nudge or "Your star is waiting. Back to {goalTitle}?"), at most once per 2 minutes. Clicking it focuses the window.
- 3 consecutive failures (capture or API) → status `error` with a short message; `resume()` retries.
- `pause()` stops the timer and releases the camera; `resume()` restarts (paused time is not counted: reset the "previous check" time to now). `stop()` → `idle`, releases the camera, keeps `lastCheck` for display.
- `setCamera(enabled)` turns the webcam on/off immediately (stop all tracks when off).
- `powerMonitor` `lock-screen` and `suspend` → auto `pause()` with `error: null`; do not auto-resume.
- Images exist only in memory for one request. Never write them to disk or log them. Log only one short line per check: verdict, confidence, counted seconds.

## Capture window

Hidden `BrowserWindow` (`show: false`, its own preload or `ipcRenderer` via a tiny preload, sandboxed). It opens the camera only when the camera is enabled and a session is active, and stops all tracks otherwise. Frame grab: draw the current video frame on a canvas, `toDataURL('image/jpeg', 0.7)`, strip the prefix.

## Root scripts

Already done: `npm run desktop` at the `north-star` root starts points, api, web and then `npm --prefix desktop start` (it waits for http://localhost:5173). Do not edit files outside this folder.

## Acceptance checks (run them yourself)

1. `node --check main.mjs focus.mjs capture.js scripts/selftest.mjs` and `node --test test/` pass. Tests cover: start schedules the first check at 5 s; sinceSeconds excludes paused time; no overlapping checks; two confident off-track checks notify once and the cooldown holds; three failures → `error`; stop releases the camera.
2. `scripts/selftest.mjs`: starts a mock API on port 8799 (records requests and answers `/api/focus/check` with alternating on_track/off_track), then launches Electron with `API_URL=http://localhost:8799`, `WEB_URL` pointing at a tiny local test page served by the same mock (the page calls `window.northStarDesktop.focus.start(...)` with camera off and prints the states it receives to the console), `CHECK_SECONDS=10` and an env flag `NORTH_STAR_SELFTEST=1` that makes the app quit after 2 checks. It passes when the mock saw 2 requests with a non-empty JPEG `screen` (decode the base64 and check the JPEG magic bytes) and the page saw `active` states with `lastCheck` set. Print a PASS/FAIL summary. If the sandbox blocks launching a GUI or capturing the screen, say exactly what failed in DONE.md instead of faking it.

Write `DONE.md` here: what you built, how to run it, test results, and anything that did not work.
