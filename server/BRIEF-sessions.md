# Brief: next step + session recap

Implement the **Server** part of `../SESSIONS.md` in this backend. Read it, `../CONTRACT.md` and `src/` first. Keep everything else working. Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server` (plus the `../CONTRACT.md` edit). Never print `.env` values. No git commits. Do NOT use ports 8787/8788 (the user's app runs there); test with `API_PORT=8793` and `POINTS_URL=http://localhost:9`, server in the background, stopped at the end.

## Model
- `NSSession` nodes as specified, linked `(:NSGoal)-[:HAD_SESSION]->(:NSSession)`. `drifts` = number of `off_track` checks.
- `Goal.sessions` (5 newest first) loaded in `loadGoals`/`getGoal` without multiplying rows (same pattern as details). Include NSSession in the user cascade delete.

## Agent (use `process.env.CHAT_MODEL`, same client, JSON parsing, one retry, safe fallbacks)

`nextStep(goal, settings)`, system prompt verbatim:
```
You are North Star, a practical coach. Pick the ONE best thing for the user to do right now toward their goal.
Goal (JSON): {GOAL_JSON}
Prefer the first undone milestone; break it into a concrete task that fits one focus session. Use their listed actions when one fits. Never repeat a task from their recent sessions unless it was clearly unfinished.
Respond with ONLY a JSON object:
{"task": string (max 10 words, starts with a verb), "minutes": 15 | 25 | 50 | 90, "why": string (one short sentence), "milestoneId": string | null}
```
Fallback: task = first undone milestone title (or "Spend time on " + goal title), minutes 25, why "", milestoneId accordingly. Snap minutes to the nearest of 15/25/50/90.

`recapSession(goal, input, settings)`, system prompt verbatim:
```
You are North Star, an honest, warm coach. A focus session just ended. Recap it from the data only; never invent progress.
Goal (JSON): {GOAL_JSON}
Session (JSON): {SESSION_JSON}
- headline: max 8 words, specific to what happened.
- summary: 1-2 sentences in second person. Credit the verified minutes; if verified time is low, say so kindly and plainly.
- driftNote: if there were off_track checks, one sentence naming the pattern from their reasons (e.g. "You drifted to YouTube twice, both in the second half."); else "".
- next: the next concrete task (max 10 words, starts with a verb) and minutes (15, 25, 50 or 90).
- suggestMilestoneId: the id of the milestone this session completed, only if verified time is at least 70% of planned AND the task clearly matches that milestone; otherwise null.
Respond with ONLY a JSON object:
{"headline": string, "summary": string, "driftNote": string, "next": {"task": string, "minutes": number}, "suggestMilestoneId": string | null}
```
Append the helpfulness style line to both prompts like the other prompts do. Goal JSON includes milestones (id, title, done), subgoal/action details, and the last 3 sessions (task, verified minutes). Session JSON includes task, plannedMinutes, activeMinutes, verifiedMinutes, completed, and the checks (verdict + reason only, max 40, evenly sampled if more). Validate `suggestMilestoneId` belongs to the goal and is undone, else null.

## Routes
As specified in SESSIONS.md, zod-validated (checks max 200, reasons max 200 chars, `task` 1-120 chars, `plannedMinutes` 5-180). 404 for unknown user/goal or a goal that is not theirs. The recap route saves the session even if the AI call fails (headline fallback "Session saved", summary from the numbers).

## Acceptance
1. `npx tsc --noEmit` passes.
2. `scripts/sessions-test.ts` against the background server (user `Zz Session Test`, a ready goal with 2 milestones created through the model): next-step returns a sensible task (print it); recap with 25 planned, 1500 active, 1260 verified, two off_track checks with reasons "watching YouTube" → prints headline/summary/driftNote/next, `suggestMilestoneId` is the first milestone id when the task matches it; `GET /api/users/:id` shows the session on the goal. Delete the user, stop the server, port 8793 free.
3. Update `../CONTRACT.md` (two routes, `Goal.sessions`).

Write `DONE-sessions.md` with the test output.
