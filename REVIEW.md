# Review: North Star v2 (second opinion)

Scope: `git diff main...v2 -- server/src web/src` plus the new files `server/src/panel.ts`, `server/src/panel.test.ts`, `server/scripts/panels-test.ts`, `web/src/ui/PanelTrack.tsx`, `web/src/ui/widgets/`. Contract: `PANELS.md`. Read-only review: no servers started, no commits, nothing edited except this file.

**Verdict: no high-severity defects.** The sanitizer, the ownership checks, the proof-image handling, the entry cascades and the points chunking all held up under adversarial testing. Four real low-severity findings below, then the areas I checked and cleared, then accepted-behavior notes.

How I verified: full read of the diff and the new files; ran the pure unit tests (`npx tsx --test src/panel.test.ts` — 32/32 pass); `tsc --noEmit` clean on both packages; ran five adversarial probes against `sanitizePanel`/`keepLogIds` from a scratch file outside the repo (id hijacking across widget types, duplicate widget/item ids, >8 widgets with a late log, ambiguous counter field, duplicate ticked checklist text) — all handled correctly.

## Findings (by severity)

### 1. Low–medium — the client cannot tell the undo route's two 409s apart, so a *conflict* hides the "Undo last change" link and claims "Nothing left to undo"

- `server/src/index.ts:825-833` — undo answers 409 with `nothing to undo` for `'empty'` and 409 with `the panel just changed; try again` for `'conflict'`.
- `web/src/App.tsx:405-418` — `undoPanel` treats **any** 409 as "empty": `const empty = err instanceof ApiError && err.status === 409`, then `setNoUndo(nu => ({ ...nu, [goalId]: version }))` and toasts "Nothing left to undo."

Scenario: the stored-raw guard in `commitPanel` (`model.ts`, `WHERE coalesce(g.panel,'') = $expected`) exists for a second v2 server process on the same Neo4j (overlapping restart, two dev instances). A user clicks Undo exactly while that other process saves a panel change between `readPanelState` and the guarded `SET` → the server answers 409 *conflict*. The client then (a) tells the user there is nothing to undo, which is false — the undo stack is not empty — and (b) records `noUndo[goalId] = version`, hiding the lasting "Undo last change" link at the current version. The user can't reach undo again until the panel changes once more or the app reloads (`noUndo` is memory-only). Note the in-process lock makes `'conflict'` impossible from this server's own requests; it is exactly the cross-process case the guard was built for, and the client mislabels it.

Fix: return a machine-readable code with the 409 body (`{ error, code: 'empty' | 'conflict' }`) and gate `setNoUndo`/the message on `code === 'empty'` only.

### 2. Low — a failed coach `edit_panel` (or dropped `log_entry`) is silent, so the coach's reply can promise a change that never happened

- `server/src/index.ts:348-353` (action loop), `:749-764` (`logEntryFromChat` returns `null` on invalid values), `:767-777` (`editPanelFromChat` returns `null` when `changePanel` yields `'failed'`, `'conflict'` or a gone goal).

Scenario: the user types in chat *"can you add a weekly chart of my km?"*. The coach model returns its reply and the `edit_panel` action in the same call, so the reply typically says "Done, I added a weekly km chart." The panel editor's model call then fails (chatJson's two attempts exhausted), or the panel changed twice mid-edit → `'conflict'` → no `panel_updated` event, no error anywhere, panel unchanged. The user believes the chart exists. Same class: `log_entry` values that fail even lenient validation (e.g. the model sends `"feeling": "amazing"` for a rating field) → no entry stored, no event, reply may still say it was logged.

Fix: emit a failure event (`panel_updated_failed` / `entry_logged_failed`) that the web client toasts, or have the server append a one-line caveat to the reply when an action it announced was dropped.

### 3. Low — removing (or redesigning away) a log widget orphans its entries: invisible, still shipped on every goal load, and no longer deletable from the UI

- `server/src/panel.ts:480-483` (step 5 drops a log beyond the cap) and `:574-603` (`keepLogIds` only re-attaches entries when a new log shares a field key+kind);
- `server/src/model.ts:341-350` (`ENTRIES_CYPHER` loads every `NSEntry` of the goal, no widget filter);
- `web/src/ui/PanelTrack.tsx:187` / `LogWidget` — entries are only ever listed under their log widget.

Scenario: a running goal has 350 photo-verified entries. The user says *"scrap the tracking — just milestones and a checklist."* The editor drops the log; no new log shares a field, so `keepLogIds` does not restore the id. The 350 `NSEntry` rows keep `widgetId` of a widget that no longer exists. They are still loaded into `goal.entries` on every poll (eating the 400-entry / 400-day budget), still sent to the coach as `recentEntries` (`agent.ts`, `coachPanelJson`), but rendered nowhere — and the UI's only entry-delete path lives inside a `log` widget, so the user can no longer see or delete them. Undo restores the log and they reappear, so no data is lost; the defect is the loss of visibility and control plus the dead weight in every read.

Fix options: when a change would drop a log that still has entries, either keep the log, surface the orphaned entries in the Track tab (count + delete), or prune them once the change leaves the undo window.

### 4. Low — v1→v2 regression: a focus session running on *another* goal is no longer surfaced on goals without a focus widget

- `web/src/ui/GoalPanel.tsx:108-109, 245` — v1 always rendered `<div className="gp-dock">{dock}</div>`; v2 renders it only when `pinnedDock` (session/recap on *this* goal) or inside a `focus_session` widget body.

Scenario: a 25-minute session is running on "Thesis". The user opens "Marathon", whose AI-designed panel (offline profile) has no `focus_session` widget and no session of its own → `pinnedDock` is false and no focus widget renders the dock → v1's "You're focusing on 'Thesis'…" hint is gone from that screen. The sidebar live dot remains and switching back to the other goal still gives full control, so this is a lost awareness cue rather than lost control, but it is a behavior the diff removes.

Fix: pin the dock also when `focus.status !== 'idle' && focus.goalId !== goal.id` (SessionDock's `elsewhere` branch already handles that state).

## Checked and clean (against the brief's list)

- **Sanitizer gaps — none found.** Unknown types dropped; every string goes through `cleanText` (HTML/script contents, markdown links incl. nested/deep-paren forms, control chars, bidi/zero-width, length caps by code points); ids are unique and type-stable against the previous spec; caps enforced (8 widgets, 1× milestones/focus_session/next_step, 2× log, 5 fields, 10 items, 4 session lengths, 10 undo entries); sources must name a log in the same spec (refs and malformed ids aliased, then re-resolved) and counter/chart fields must be number/minutes fields of that log; dependents of dropped logs fall off (incl. logs beyond the 8-cap); a counter target that rounds to 0 is rejected; `__proto__`/`constructor` keys are neutralized everywhere they can appear (field keys validated, `hasOwnProperty`/`Object.hasOwn` reads, fresh value objects). There is **no route that accepts a raw spec from the client** — the only client-written panel inputs are zod-validated ops, instructions (≤300 chars) and entries — so "client-written spec" reduces to AI output through the same sanitizer.
- **Rendering safety.** All spec strings (titles, notes, proof hints, reasons, item text, entry values) render as React text children; no `dangerouslySetInnerHTML`/`innerHTML` anywhere in `web/src`; no spec-derived `href`/`src`; the proof thumbnail is a canvas-generated `data:` URL.
- **Proof images.** Never stored (`NSEntry` keeps only `proof`/`proofReason`; the base64 never reaches any write), never logged (`[proof] <verdict> <confidence>` only), sent to the vision model once, in the *user* message as data, with free-text field values excluded; magic-byte, size (4 MB) and base64 validation before the call; fail-soft to "unverified".
- **Ownership.** Every new route re-checks `(:NSUser {id})-[:PURSUES]->(:NSGoal {id})` in Cypher (design/edit/undo/ops/entries/delete; `logEntryFromChat` and `logCheckin` included); `panels-test.ts` confirms 404s for foreign users on all of them.
- **Privacy.** Verified-entry minutes reach the points service only with `settings.shareGoalTitle && goal.public`, title omitted otherwise (`countVerifiedEntry`); brightness/NSActivity stay local; `panelPrev` is explicitly nulled out of every goal read so the undo stack never leaves the server.
- **Neo4j.** `ENTRIES_CYPHER` collapses entries per goal (collect + `[0..400]`) *before* the activity sum — no row multiplication; `deleteGoal` collects each part (milestones/details/sessions/entries) in its own step before `FOREACH DETACH DELETE`; the user cascade, seeded cleanup (`HAS_DETAIL|HAD_SESSION|HAS_ENTRY`) and the 10-minute orphan sweep all cover `NSEntry`.
- **Points intervals.** `splitInterval` makes equal parts of ≤15:00 (never more, even with rounding, proven by the unit tests), skips totals <5 s, keeps every part ≥5 s, ends at the entry time, one `nanoid()` per chunk; per-entry 180-min and rolling-24h 240-min caps enforced under a per-user lock; first points failure breaks the loop (no stacked 4 s timeouts).
- **Widget math.** Calendar-local periods, Monday weeks, constructor-based month/year and DST-safe day arithmetic; streak keeps the current open period from breaking the run; `recorded` keeps "No"/0-value check-ins out of streaks and grids while leaving them in the log; chart/counter/habit-grid bucketing is boundary- and timezone-correct; the client's optimistic `applyWidgetOp` matches the server's clamp semantics for `move` exactly.
- **Design calls / camera / state.** One lazy design per goal per session (`designAsked`), server-side idempotent (existing panel returned unchanged; `savePanel(base: null)` conflicts instead of clobbering a racing window); retry button unmounts itself. `CameraSheet` stops tracks on unmount, late permission grant, capture and close. Panel/entry writes are queued per goal, stale poll responses are discarded via `panelSeq`, failed ops refresh from the server when they're the latest, and ticks made during a slow AI edit are carried server-side by `sameLayout`/`carryProgress`.

## Notes — accepted or pre-existing (not defects)

- Deleting a verified entry does not reverse its counted minutes or reported points — matches v1's sessions and the contract's silence; farming still requires photo verification.
- A hung model call can hold `panelBusy > 0` (pausing the 10 s sync loop) for up to ~2–4 minutes (60 s client timeout × 2 attempts, ×2 for a redo-on-conflict); self-heals, and the same pattern existed for v1 chat calls.
- Milestone toggles don't bump `panelSeq`, so a poll response in flight during a toggle can briefly revert it on screen (≤10 s) — the unchanged v1 pattern, not introduced by this diff.
- `logCheckin`'s 24 h window is measured from `now` over `a.at` (rolling, per the contract's "in any 24 hours").
- Overlapping points intervals from two verified entries logged close together are possible by design ("intervals ending at the entry time"); the 180/240-minute caps bound it.

## Resolution (2026-10-17)

All four findings were confirmed and fixed on `v2` (OpenCode on ai& GLM-5.3 from `BRIEF-fix.md`, reviewed and adjusted by Claude):
1. The undo 409s now carry `code: 'empty' | 'conflict'`; only `'empty'` hides Undo. `panels-test.ts` asserts the code.
2. A dropped `edit_panel` / `log_entry` appends one honest sentence to the coach reply.
3. Entries of a removed log show in a collapsed "Entries from a removed log" card on the Track tab, deletable; Undo rehomes them.
4. A session on another goal shows a one-line "You're focusing on …" cue when no focus widget is on screen (not a second Begin focus card).

Checks: server tsc, 32/32 sanitizer tests, 99/99 e2e (`panels-test.ts`), web tsc + build, browser smoke of fixes 1 and 3.
