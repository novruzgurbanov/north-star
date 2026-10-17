# Brief: quick-capture goals, details later

Today the agent interviews the user (3–7 questions) before a goal exists. Users find that too much. New flow, mirroring the teammate's Goal Coach app:

1. The user writes a goal in a few words → a **little star** (a goal with status `brainstorm`) is created **immediately** from that one message.
2. Details (why, what success looks like, first steps, deadline) are added **later and optionally**, one light question at a time, in that goal's chat. Each detail makes the star grow.
3. When the goal has a success description **and** at least one milestone, its status becomes `ready`.

Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server` (plus the `../CONTRACT.md` edit at the end). Read `../CONTRACT.md` and all of `src/` first. Keep every other route and behaviour working. Never print `.env` values. No git repo; do not commit. Do NOT start the server on port 8787 or 8788 (the user is running the app right now); for tests use `API_PORT=8790` and `POINTS_URL=http://localhost:9` (points calls fail soft, which is fine) set in the shell.

## Goal shape (src/types.ts + model.toGoal)

Add to `Goal`:
```ts
status: 'brainstorm' | 'ready'        // ready = successLooksLike non-empty AND milestones.length >= 1
missing: Array<'success' | 'steps' | 'why'>   // in that order, only the ones still empty
```
Brightness: brainstorm goals `0.12 + 0.04 * (number of filled among why, successLooksLike, deadline, ≥1 milestone)`; ready goals keep the current formula.

## Model (src/model.ts)

- `createGoal` must accept zero milestones (and empty `why` / `successLooksLike`). Make sure the goal is still created when the milestone list is empty (the current `UNWIND` would otherwise skip nothing, but the early `return null` must go).
- New `updateGoalDetails(userId, goalId, { title?, why?, successLooksLike?, deadline? })`: only sets fields that are non-empty strings (title max 6 words / 80 chars, others 200 chars, deadline 60 chars). Returns the fresh Goal or null if not theirs.

## Agent (src/agent.ts)

### New `capture(messages)` → `{ isGoal, title, reply, suggestions }`

Used for `POST /api/chat` without `goalId` (replaces `discover` there; keep `discover` exported but unused). System prompt, verbatim:

```
You are North Star. The person is writing down something they want to reach. Your job is to capture it as a goal right away, not to interview them.

If their message names a goal, aspiration or project (even vaguely), it is a goal:
- "title": the goal in at most 6 words, starting with a verb, using their words (e.g. "Run my first half marathon").
- "reply": one or two short, warm sentences. Name the goal back to them, tell them its little star is now in their sky under Brainstorm, and that they can add details whenever they like. You may end with ONE light, optional question about what success would look like. No lists, no emojis.
If the message is not a goal yet (a greeting, a question, small talk), set "isGoal": false and reply with one short sentence inviting them to write something they want to reach.
Reply in the language the user writes in.

Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.

Respond with ONLY a JSON object:
{"isGoal": boolean, "title": string, "reply": string, "suggestions": string[]}
```

### `coach(goal, stats, messages)`: also refines brainstorm goals

Replace the coach system prompt with this one (keep the same JSON parsing, retries and fallback):

```
You are North Star, a warm, honest coach. The user's goal is a star in their sky; each milestone is a smaller star that lights up when done.
Goal (JSON): {GOAL_JSON}
Today: {TODAY}. Their stats: {STATS_JSON}

If the goal's status is "brainstorm", it is a little star with few details. Help them add details lightly:
- Ask at most ONE short question per reply, about the first item in "missing" ("success": how they will know they made it; "steps": the first 2-3 concrete steps; "why": why it matters to them).
- Record what they tell you with actions. If they would rather just start, respect that and stop asking.
When the goal is "ready", keep track of their progress like a good accountant of effort:
- When the user says they finished a milestone, mark it done.
- When they describe work they did with a duration, log focus minutes (only time they say they actually spent).
- If they discover a missing step, add a milestone.
Always: reply in 1-3 short sentences, acknowledge concretely, no lists, no emojis, in the user's language. Never invent details or progress the user did not give you.

Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.

Respond with ONLY a JSON object:
{"reply": string, "suggestions": string[],
 "actions": [ {"type":"set_details","why"?: string,"successLooksLike"?: string,"deadline"?: string,"title"?: string}
            | {"type":"add_milestone","title": string}
            | {"type":"complete_milestone","milestoneId": string}
            | {"type":"log_focus","minutes": number} ]}
```

Parse `set_details` (only string fields), allow up to 4 `add_milestone` actions per turn (each title max 6 words).

## Route `POST /api/chat`

- **No `goalId`**: call `capture`. If `isGoal` and a title: `createGoal(userId, { title, why: '', successLooksLike: '', deadline: null, milestones: [] })`, emit `goal_created`, `understanding: 1`, share the title with the points service exactly like the current code does on `goal_created`. If not a goal: no event, `understanding: 0`. `phase: 'discovering'`. Return `suggestions` from capture.
- **With `goalId`**: as today, plus apply `set_details` via `updateGoalDetails` and emit `{ type: 'details_updated', goalId, goal }` (the fresh goal). After applying all actions, if the goal's status went from `brainstorm` to `ready`, also emit `{ type: 'goal_ready', goalId }`. Keep emitting the existing event types.

## Acceptance checks

1. `npx tsc --noEmit` passes.
2. Script `scripts/capture-test.ts` (start the server yourself on `API_PORT=8790` with `POINTS_URL=http://localhost:9`, in the background; use a throwaway user named `Zz Capture Test`):
   - `POST /api/chat` with only "I want to learn to play guitar" → `goal_created` in the same response, goal `status: 'brainstorm'`, `milestones: []`, a short reply mentioning Brainstorm, 2-3 suggestions.
   - "hi" → no goal created, `understanding: 0`.
   - With that `goalId`: "I'll know I made it when I can play Wonderwall for friends" → `details_updated`, `successLooksLike` set, `missing` no longer contains `success`.
   - Then: "First I'll buy a guitar, learn 4 chords, then practice 15 min a day" → milestones added, `goal_ready` emitted, `status: 'ready'`.
   - Print each reply and the suggestions.
3. Delete the test user (`model.deleteNonSeededUsersByName('Zz Capture Test')`), stop the server you started, port 8790 free.
4. Update `../CONTRACT.md` (Goal type, new event types, the `/api/chat` description).

Write `DONE-capture.md` here: what changed, the test transcript, and anything that did not work.
