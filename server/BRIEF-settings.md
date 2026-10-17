# Brief: per-user settings

Implement `../SETTINGS.md` in this backend. Read it, `../CONTRACT.md` and all of `src/` first. Keep everything else working. Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server` (plus the `../CONTRACT.md` edit). Never print `.env` values. No git commits. Do NOT use ports 8787/8788 (the user's app is running); test with `API_PORT=8792` and `POINTS_URL=http://localhost:9` in the shell, server in the background, stopped at the end.

## Storage

Store settings as a JSON string property `settings` on `NSUser`. `model.getSettings(userId)` returns defaults merged with what is stored (unknown keys dropped, invalid values replaced by defaults). `model.updateSettings(userId, partial)` validates with zod (exact enums, `checkSeconds` integer 10..300, booleans), merges, saves, returns the full settings. Put the type and `DEFAULT_SETTINGS` in `src/types.ts`.

## Routes

- `GET /api/users/:userId/settings` → `{ settings }`; `PUT` same path with a partial body → `{ settings }` (400 on invalid values, 404 unknown user).
- `GET /api/users/:userId` also returns `settings`.
- When `shareGoalTitle` changes to false, immediately set the points player's `goalTitle` to `null` (fail soft). While it is false, never send a goal title to the points service anywhere (goal created, active goal, focus intervals: omit `goalTitle`).

## Agent

- `capture`, `coach` and `checkFocus` take the user's settings (load them in the route).
- Append the helpfulness style line from SETTINGS.md (verbatim) as the last line of the capture and coach system prompts.
- Roast level in `checkFocus`: `off` → replace the roast paragraph's instruction with `Never write a roast; "roast" must be "".` and force `""`; `mild` → keep the current paragraph; `spicy` → keep the current paragraph and append `Make it sharper and more sarcastic, like a friend who roasts you, but still PG and still never about the person.`
- Strictness in `POST /api/focus/check`: count threshold per SETTINGS.md (replace the fixed 0.6) and return `notifyAbove` (the notify threshold) in the response.

## Acceptance

1. `npx tsc --noEmit` passes.
2. `scripts/settings-test.ts` against the background server (user `Zz Settings Test`): GET returns defaults; PUT `{helpfulness:'quiet', roast:'off', checkSeconds: 45}` returns merged settings; PUT `{checkSeconds: 5}` → 400; capture with quiet gives a reply with no question mark (print it); a focus check on a generated "YouTube - Funny cat compilation #47" JPEG with `roast:'off'` returns `roast: ""`, with `roast:'spicy'` a non-empty roast (print both), and `notifyAbove` matches strictness. Delete the user, stop the server, port 8792 free.
3. Update `../CONTRACT.md` with the two routes and the `settings`/`notifyAbove` fields.

Write `DONE-settings.md` with what changed and the test output.
