# Brief: fix 4 small review findings in North Star v2

Work in `C:\Users\nowru\Documents\assistant\hackathon\north-star-v2` (git branch v2). `REVIEW.md` has the full findings; `PANELS.md` is the contract.

Rules: never touch `C:\Users\nowru\Documents\assistant\hackathon\north-star` (v1). Do not start any server or bind any port. Never print `.env` values. Do not git commit. Keep changes small and in the style of the surrounding code (same comment density, naming, idioms). No new dependencies.

## Fix 1: undo's two 409s (finding 1)
- `server/src/index.ts`: give `HttpError` an optional `code?: string` (third constructor arg). The error handler sends `{ error: err.message, code: err.code }` when `code` is set, `{ error }` otherwise. In the undo route, use code `'empty'` for "nothing to undo" and `'conflict'` for "the panel just changed; try again".
- `web/src/api.ts`: `ApiError` gets an optional `code` parsed from the JSON error body.
- `web/src/App.tsx` `undoPanel` (around line 405-418): only `err.code === 'empty'` sets `noUndo` and toasts "Nothing left to undo."; a `'conflict'` toasts "The panel just changed. Try Undo again." and does not touch `noUndo`; anything else keeps "Could not undo that change."

## Fix 2: silent coach action failures (finding 2)
In the coach branch of the chat route in `server/src/index.ts` (the `for (const action of result.actions)` loop, around line 311-355): when an `edit_panel` action returns no event from `editPanelFromChat`, or a `log_entry` action returns no event from `logEntryFromChat`, remember it, and after the loop append one short sentence to `reply`:
- edit failed: ` (I couldn't change the panel just now. Ask me again in a moment.)`
- entry failed: ` (I couldn't log that one. Use the log form on the Track tab.)`
Append each sentence at most once per turn. Do not change the response shape.

## Fix 3: entries orphaned by a removed log widget (finding 3)
`web/src/ui/PanelTrack.tsx`: entries whose `widgetId` is not the id of any current `log` widget in `goal.panel` are currently invisible. Below the widgets, when there are any, render one small card titled "Entries from a removed log" with a count, collapsed by default (a button toggles it). Expanded, list them newest first (date + a short `key: value` summary of `values`, plus `minutes` when > 0) with a delete button per entry that calls the existing `track.onDeleteEntry(entry.id)`. Reuse existing CSS classes from the widget cards where possible; add only minimal CSS to `web/src/styles.css` if needed. Undo restoring the log must make them reappear in their log widget (this falls out naturally since the filter is computed from the current panel).

## Fix 4: focus session elsewhere not shown (finding 4)
`web/src/ui/GoalPanel.tsx` around line 105-109: `pinnedDock` must also be true when a focus session is running on another goal (`focus && focus.status !== 'idle' && focus.goalId !== goal.id`, same test as `elsewhere` in `web/src/ui/SessionDock.tsx` line 70) and this panel shows no `focus_session` widget on the current tab. Use whatever `focus` prop/variable GoalPanel already has; if it has none, pass it down from where `SessionDock` gets it.

## Acceptance (run these and report results)
- `server`: `npx tsc --noEmit` and `npx tsx --test src/panel.test.ts` pass.
- `web`: `npx tsc --noEmit` and `npx vite build` pass; delete `web/dist` afterwards.
- `git -C C:\Users\nowru\Documents\assistant\hackathon\north-star status --short` is empty.

Write `DONE-fix.md` here: one line per fix with the files changed, then the check results.
