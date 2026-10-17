# North Star desktop shell

Implemented in this folder only. No dependencies were added and no commits were made.

## Files

- `main.mjs`: Electron lifecycle, 1440×900 dark window and title bar, startup fallback with 3-second retries, primary-display JPEG capture, 45-second API timeout, validated IPC, origin-restricted navigation and media permissions, native notifications, and pause on lock/suspend.
- `preload.cjs`: exact `window.northStarDesktop` bridge from `../DESKTOP.md`, including state subscriptions and unsubscribe.
- `focus.mjs`: independent focus controller with injected clock/capture/API adapters. First check at 5 seconds, configurable subsequent checks after the previous request finishes, pause/resume accounting, goal switching, stale-result cancellation, camera controls, notification cooldown, and error/retry handling.
- `capture.html`, `capture.js`, `capture-preload.cjs`: sandboxed hidden webcam helper. The extra tiny preload keeps `ipcRenderer` isolated from the page. Frames are 640×360 JPEG at quality 0.7, with a 3-second command timeout; tracks stop on pause, stop, camera-off, or exit. Camera failures allow screen-only checks and preserve the user's camera preference.
- `test/focus.test.mjs`: 17 deterministic `node:test` tests. `test/package.json` provides the directory entry point required by this machine's Node 24 for the exact `node --test test/` command.
- `scripts/selftest.mjs`: mock API and bridge test page on port 8799, real Electron launch/capture attempt, JPEG magic-byte validation, renderer-state acknowledgements, PASS/FAIL summary, and server/process cleanup.
- `package.json`, `.gitignore`: test/selftest commands and ignored local runtime data.

Screenshots and webcam frames are never written to disk or logged. The canvas is cleared after frame capture. Per-check logs contain only verdict, confidence, counted seconds, and a failure marker when needed. Electron's local browser profile is kept under ignored `.north-star-runtime/`.

## Run

With the web UI and API running, from this folder:

```powershell
npm start
```

The existing `npm run desktop` command at the `north-star` root also starts the complete stack. Its files were not changed.

Optional settings (defaults shown):

```powershell
$env:WEB_URL = 'http://localhost:5173'
$env:API_URL = 'http://localhost:8787'
$env:CHECK_SECONDS = '30' # Minimum 10 seconds
npm start
```

The web UI controls focus through the bridge. Resume works from paused/error and schedules a fresh check after 5 seconds. Locking or suspending pauses without automatically resuming. If the web UI cannot load, the built-in page explains running `npm run dev` from `north-star` and retries every 3 seconds.

## Verification results

- **PASS:** individual `node --check` runs for `main.mjs`, `focus.mjs`, `capture.js`, `preload.cjs`, `capture-preload.cjs`, `scripts/selftest.mjs`, and `test/focus.test.mjs`.
- **PASS:** `node --test test/` — 17 passed, 0 failed. Covers first-check timing, exact state fields, paused-time exclusion, no overlapping requests, goal changes during requests, stale captures, camera-off during capture, notification streak/cooldown, capture and API failure recovery, success resetting failures, stop releasing camera, optional camera failure, invalid arguments/responses, and the 900-second accounting cap.
- **BLOCKED at Electron launch:** `node scripts/selftest.mjs` was run twice (also with Electron logging enabled). The mock successfully listened on `http://localhost:8799`, but Electron exited immediately with **2147483651 (`0x80000003`, Windows breakpoint exception)**, no diagnostic output, **0 API requests**, and **0 renderer states**. This was a real failed attempt; no screenshot or renderer success was fabricated.
- **Independent runtime probe:** launching the installed `node_modules/electron/dist/electron.exe --version --enable-logging=stderr` with `Start-Process -Wait` also exited with signed **-2147483645**, the same `0x80000003`. That command does not load this app. This points to an Electron/runtime or launch-environment failure; the exact underlying cause could not be established here. Sandbox protections were kept enabled.
- **Cleanup:** the self-test mock was stopped; port 8799 had no listener after the attempts.

Because the installed Electron binary cannot start in this run, actual window appearance, screen capture, webcam access, Windows notifications, startup retries, and power events remain **unverified on a live desktop**. The real North Star API/vision/points stack was not needed or exercised. After resolving the Electron launch failure, run `npm run selftest` in an interactive Windows session; it must report two real JPEG requests and both renderer verdicts before treating the desktop integration as verified.
