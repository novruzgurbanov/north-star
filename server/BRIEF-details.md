# Brief: goal details graph + roasting focus judge

Two features for the North Star backend (this folder). Read `../CONTRACT.md` and all of `src/` first. Keep every existing route and behaviour working. Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server` (plus the `../CONTRACT.md` edit at the end). Never print `.env` values. No git repo; do not commit. Do NOT use ports 8787 or 8788 (the user's app is running); for tests run the server with `API_PORT=8791` and `POINTS_URL=http://localhost:9` set in the shell. **Do not start any process in the foreground that never exits** (servers go in the background; stop them yourself at the end).

## 1. Goal details (same vocabulary as the teammate's Goal Coach app)

Store small facts about a goal as a graph:

```
(:NSGoal)-[:HAS_DETAIL]->(:NSDetail {id, kind, text, createdAt})
kind: 'subgoal' | 'action' | 'motivation' | 'obstacle' | 'distraction' | 'on_track'
```

- `types.ts`: `GoalDetail = { id: string; kind: DetailKind; text: string; createdAt: string }`; `Goal` gains `details: GoalDetail[]` (sorted by createdAt). New event `{ type: 'detail_added'; goalId: string; detail: GoalDetail }`.
- `model.ts`: load details in `loadGoals`/`getGoal` (OPTIONAL MATCH; keep milestones correct, avoid row multiplication). New `addDetail(userId, goalId, kind, text)`: text trimmed, max 120 chars; skip exact duplicates per goal (case-insensitive) and stop at 30 details per goal; returns the detail or null. Include `NSDetail` in `deleteUserCascade` / `deleteNonSeededUsersByName`.
- `agent.ts` coach prompt: add these lines just before the "Also offer 2-3 suggested replies" paragraph (verbatim):

```
Whenever the user mentions why the goal matters, something in the way, something that pulls them off track, a sub-goal, a concrete action, or what working on it looks like on their screen, record it with an add_detail action (kind: motivation | obstacle | distraction | subgoal | action | on_track; text: at most 12 words, in their words). Do not repeat details already in the goal JSON.
```
  and add `| {"type":"add_detail","kind": string,"text": string}` to the actions union in the JSON shape. Parse it (valid kind only, non-empty text). Max 5 `add_detail` actions per turn. Make sure the goal JSON given to the coach includes `details` (kind + text only).
- `agent.ts` capture prompt: add `"details": [{"kind": string, "text": string}]` to its JSON shape with this line before "Also offer 2-3 suggested replies": `If the message already says why it matters, what is in the way, or what distracts them, put those in "details" (same kinds as above, at most 12 words each). Otherwise "details": [].` Return them from `capture`.
- `index.ts`: apply `add_detail` actions (coach) and capture details (right after `createGoal`) via `addDetail`, emitting `detail_added` events. Coach answers that add a `motivation` detail should also set `why` if it is still empty (call `updateGoalDetails` with that text) so `missing` stays meaningful.

## 2. Focus judge: personal criteria + roast

In `checkFocus` (agent.ts):
- Add to the goal JSON sent to the vision model: `onTrackLooksLike` (texts of `on_track` + `action` details) and `knownDistractions` (texts of `distraction` details).
- Replace the system prompt with this one (verbatim):

```
You check whether a person is working on their goal right now, from a screenshot of their screen and, if present, a webcam photo.
Goal: {GOAL_JSON}

Judge only what is visible.
- on_track: the main thing on screen plausibly serves the goal (relevant documents, code, tools, research, learning material, writing, anything in onTrackLooksLike), or the webcam shows them doing an offline activity tied to the goal (practising the instrument, reading, studying on paper, training).
- off_track: clearly unrelated entertainment, social feeds, shopping or games as the main activity, anything in knownDistractions, or nobody at the desk with nothing relevant happening.
- uncertain: anything you cannot judge fairly.
Be fair: a chat or music app in a corner is fine when the main window is work. Do not describe the person's appearance and do not quote private content from the screen.

When off_track, also write "roast": one playful, witty line (max 18 words) teasing what they are doing instead of their goal, based on what is on the screen or what they are doing on camera. Tease the activity, never the person: nothing about looks, body, clothes, age, gender, ethnicity, their home, or private content on screen. Keep it PG, no swearing, and tie it back to their goal when you can, for example: "Cat video #47: the famous missing chapter of your thesis." Otherwise "roast" is "".

Respond with ONLY a JSON object:
{"verdict": "on_track" | "off_track" | "uncertain", "confidence": number 0-1,
 "reason": string (max 14 words, second person, e.g. "You're editing your thesis draft in Word."),
 "nudge": string (one kind sentence to bring them back, only when off_track, else ""),
 "roast": string}
```
- `FocusVerdict` gains `roast` (string, trimmed, max 200 chars, forced to `""` unless `off_track`). `POST /api/focus/check` returns it.

## 3. Update `../CONTRACT.md`

Goal type (`details`), `GoalDetail`, the `detail_added` event, and `roast` in the `/api/focus/check` response.

## Acceptance checks

1. `npx tsc --noEmit` passes.
2. `scripts/details-test.ts` against a background server on `API_PORT=8791` (user `Zz Details Test`):
   - capture "I want to finish my thesis because I want to graduate, but YouTube keeps eating my evenings" → `goal_created` and `detail_added` events with a `motivation` and a `distraction`.
   - coach: "When I'm working I'm in Overleaf writing chapter 3" → `detail_added` with kind `on_track` (or `action`).
   - Mark it ready via the model (success + one milestone) and call `POST /api/focus/check` twice with JPEG screenshots you generate (any small image library as a dev dependency, e.g. `jimp`, is fine): one showing text like "Overleaf - thesis.tex - Chapter 3: Methods", one showing "YouTube - Funny cat compilation #47". Expect on_track (no roast) and off_track with a non-empty, PG roast. Print both.
   - Delete the test user, stop the server, port 8791 free.

Write `DONE-details.md` here with what changed, the test output (including the roast), and anything that did not work.
