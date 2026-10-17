# Brief: verify North Star v2 (AI-built goal panels)

You are verifying, not building. Work in `C:\Users\nowru\Documents\assistant\hackathon\north-star-v2` (git branch v2). Read `PANELS.md` (the contract) first.

Rules: never touch `C:\Users\nowru\Documents\assistant\hackathon\north-star` (v1, the user runs it). Do not bind ports 5173, 8787, 8788, 5273, 8887, 8888. For a test server use `API_PORT=8897` and `POINTS_URL=http://localhost:9` set in the shell, in the background, stopped when done. Never print `.env` values or image data. Do not git commit. Only fix something if a check fails because of a small, obvious mistake; say exactly what you changed.

Run and report:
1. `server`: `npx tsc --noEmit`; `npx tsx --test src/panel.test.ts`; then start the server on 8897 in the background and run `npx tsx scripts/panels-test.ts`; stop the server; make sure the test user "Zz Panels Test" is deleted.
2. `web`: `npx tsc --noEmit` and `npx vite build` (delete `web/dist` afterwards).
3. `points`: `npx tsc --noEmit`.
4. `desktop`: `node --test test/` (do not launch Electron).
5. `git status --short` summary.
6. `git -C C:\Users\nowru\Documents\assistant\hackathon\north-star status --short` must be empty (v1 untouched).

Write `VERIFY.md` here with a pass/fail table, the two designed panel specs printed by panels-test (running goal and thesis goal), and any failure output quoted.
