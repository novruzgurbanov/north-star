# DONE — per-user settings

Implements `BRIEF-settings.md` and `../SETTINGS.md` exactly. All work is inside `server/` plus the allowed `../CONTRACT.md` edit. Everything else keeps working; `.env` values never printed; nothing committed; ports 8787/8788 never touched (tests ran on **8792** with `POINTS_URL=http://localhost:9`); background server stopped by me and port 8792 verified free.

## What was built

| File | Change |
|---|---|
| `src/types.ts` | `Helpfulness` / `Strictness` / `RoastLevel` unions, `Settings` type (exactly the SETTINGS.md shape) and `DEFAULT_SETTINGS` (helpfulness `balanced`, checkSeconds 20, strictness `normal`, roast `mild`, notifications true, cameraByDefault false, suggestions true, sounds true, shareGoalTitle true). Two strictness threshold maps: `COUNT_CONFIDENCE` (relaxed 0.5 · normal 0.6 · strict 0.75) and `NOTIFY_ABOVE` (relaxed 0.85 · normal 0.7 · strict 0.6) |
| `src/model.ts` | `settingsSchema` (zod: exact enums, `checkSeconds` integer 10..300, booleans) + `.partial()` for updates. `sanitizeSettings(raw)` = defaults merged with stored values, unknown keys dropped, invalid values replaced by defaults. `getSettings(userId)` parses the `u.settings` JSON string (missing/corrupt → defaults). `updateSettings(userId, partial)` validates with zod (throws → route 400), merges over stored, saves the JSON string, returns the full settings |
| `src/agent.ts` | `HELPFULNESS_LINES` with the two verbatim style lines from SETTINGS.md; `withHelpfulness()` appends the line as the **last line** of a system prompt (balanced adds nothing). `coach(goal, stats, messages, settings)` and `capture(messages, settings)` wrap their system prompts with it. Focus judge: the roast paragraph moved to a `{ROAST_PARAGRAPH}` slot filled by `roastParagraph(settings.roast)` — `off` → verbatim `Never write a roast; "roast" must be "".`, `mild` → the current paragraph unchanged, `spicy` → current paragraph + verbatim `Make it sharper and more sarcastic, like a friend who roasts you, but still PG and still never about the person.` — and parsing forces `roast: ""` when the setting is `off`. `checkFocus(goal, screen, camera, settings)` takes settings |
| `src/index.ts` | New `GET`/`PUT /api/users/:userId/settings` (404 unknown user; PUT invalid → 400 via the existing zod error handler; when `shareGoalTitle` changes to false it immediately calls `points.setGoalTitle(playerId, null)` through `ensurePlayer`, fail soft). `GET /api/users/:userId` now also returns `settings`. `/api/chat` loads settings once and passes them to `coach`/`capture`; the goal-created share runs only when `shareGoalTitle` is true (`ensurePlayer` gets no title otherwise). `active-goal` only calls `setGoalTitle` when sharing is on (still returns the row). `/api/focus/check` loads settings, uses `COUNT_CONFIDENCE[strictness]` instead of the fixed 0.6, returns `notifyAbove = NOTIFY_ABOVE[strictness]`, and omits `goalTitle` from `reportFocus`/`ensurePlayer` while sharing is off |
| `scripts/settings-test.ts` | New acceptance script (server on :8792): creates `Zz Settings Test`, defaults/merge/400/dropped-key checks, quiet capture reply check, jimp-drawn "YouTube - Funny cat compilation #47" JPEG through three focus checks (roast off / spicy+strict / mild+relaxed), `shareGoalTitle` toggle, corrupt-storage sanitization via the model, deletes the user |
| `../CONTRACT.md` | `Settings` type added to Types; the two settings routes in the Endpoints table; `settings: Settings` in `GET /api/users/:userId`; `notifyAbove` in `/api/focus/check` and its "confidence ≥ 0.6" wording replaced by the strictness threshold; two bullets (roast forced empty when `off`, and the server-applied `Settings` behaviour incl. `shareGoalTitle`) |

## Acceptance checks (all run)

1. `npx tsc --noEmit` — **passes** (run after the src changes and again after adding the script; `scripts/` is in the tsconfig include).
2. `scripts/settings-test.ts` against a background server started with `API_PORT=8792 POINTS_URL=http://localhost:9 npm start` — **all checks passed**:

   - **GET settings** → exactly the defaults; `GET /api/users/:id` carries the same `settings` object.
   - **PUT `{helpfulness:'quiet', roast:'off', checkSeconds: 45}`** → merged: `{"helpfulness":"quiet","checkSeconds":45,"strictness":"normal","roast":"off","notifications":true,"cameraByDefault":false,"suggestions":true,"sounds":true,"shareGoalTitle":true}`, persisted on GET.
   - **PUT `{checkSeconds: 5}`** → **400** `"checkSeconds: checkSeconds must be at least 10"`, settings unchanged.
   - Extra: PUT `{nope:'x'}` → 200, unknown key dropped.
   - **Capture with quiet** → reply (printed): *"Finish your thesis draft — its little star is now in your sky under Brainstorm, and you can add details whenever you like."* — **no question mark**, and the goal was still created (`goal_created`).
   - **Focus check, roast `off`** (same goal, jimp-drawn "YouTube - Funny cat compilation #47" JPEG) → `off_track` 0.95, **roast: `""`** (forced), `notifyAbove: 0.7` (strictness normal).
   - **Focus check, roast `spicy` + strictness `strict`** → `off_track` 0.97, **roast: *"Compilation #47 of 500: groundbreaking research your thesis committee definitely requested."*** (non-empty, PG), `notifyAbove: 0.6`.
   - Extra: roast `mild` + strictness `relaxed` → non-empty roast *"Cat compilation #47: officially the longest chapter of your thesis so far."*, `notifyAbove: 0.85` — all three strictness values verified end to end.
   - **PUT `{shareGoalTitle: false}`** → 200, saved; the server fired the fail-soft points call (see server-log note below).
   - Extra: corrupt stored settings JSON (`"helpfulness":"loud","checkSeconds":9999,...` + unknown key) → `getSettings` returned sanitized defaults.
   - Cleanup: test user deleted (`1`), server killed (`taskkill` on the :8792 PID — that's why the background shell reports "exited with code 1", same as the previous briefs), **port 8792 verified free**; 8787/8788 never used.
3. `../CONTRACT.md` updated as listed above.

## Server log from the test run (evidence)

```
[db] constraints ready
north-star server listening on http://localhost:8792
[whisper] ready in 0.8s (model: onnx-community/whisper-base)
[points] upsertPlayer failed: fetch failed        <- intended fail-soft (POINTS_URL=localhost:9)
[focus] off_track 0.95 counted=0s in 1162ms       <- roast off
[focus] off_track 0.97 counted=0s in 1791ms       <- roast spicy
[focus] off_track 0.95 counted=0s in 899ms        <- roast mild
[points] upsertPlayer failed: fetch failed        <- shareGoalTitle=false PUT (ensurePlayer, fail soft)
```

## Notes

- `helpfulness: 'balanced'` adds no line (per SETTINGS.md); `quiet`/`proactive` lines are appended verbatim as the last system-prompt line of capture and coach only — `discover()` is unused by any route and was left untouched.
- `shareGoalTitle: false` while sharing was already off does not re-fire the points call (only a true→false transition does).
- The `[points] … failed: fetch failed` warnings are the intended fail-soft path with `POINTS_URL=http://localhost:9`; no route errors, focus checks still count locally (`countedSeconds` logic intact for on_track).
- The desktop-side half of SETTINGS.md (`focus.configure({ checkSeconds, notifications })`) lives in the desktop shell / web UI, outside this `server/` folder; the server now provides everything it needs (`checkSeconds` in settings, `notifyAbove` per focus check).
