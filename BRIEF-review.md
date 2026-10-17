# Brief: second-opinion review of North Star v2 (read-only)

Review the v2 changes for real defects. Work in `C:\Users\nowru\Documents\assistant\hackathon\north-star-v2`. **Do not edit any file except `REVIEW.md`**, do not start servers, do not commit, never print `.env` values.

Context: `PANELS.md` is the contract. v2 lets the AI design each goal's panel as a JSON widget spec (server sanitizes it, web renders built-in widgets), with log entries, photo/screenshot proof judged by a vision model, and points for verified entries. See the diff with `git diff main...v2 -- server/src web/src` plus the new files `server/src/panel.ts`, `server/src/panel.test.ts`, `server/scripts/panels-test.ts`, `web/src/ui/PanelTrack.tsx`, `web/src/ui/widgets/`.

Look for, with a concrete failure scenario each:
- Spec sanitizer gaps: any spec (AI- or client-written) that gets through with an unknown type, broken source/field reference, oversize or HTML string, duplicate ids, or more than the allowed widgets.
- Security/privacy: markup or URLs from spec strings rendered unsafely in the web UI; proof images stored or logged; missing ownership checks; private goal titles sent to the points service.
- Data: Neo4j queries that multiply rows or miss the NSEntry cascade; points intervals longer than 15 minutes.
- Web: widget math wrong across week/month/day boundaries or time zones; duplicate design calls; webcam tracks left running; state not updating after actions.

Write `REVIEW.md` with findings ordered by severity (file, line if possible, scenario, suggested fix). If you find nothing real, say so. No style nits.
