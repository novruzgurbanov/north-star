# North Star

Chat with an agent (typed or spoken) about what you want to reach. When it understands you, your goal is born as a star and its milestones become a constellation. While you work, the desktop app glances at your screen (and, if you allow it, your camera) to verify you're on task. Verified minutes brighten your stars and earn points on a leaderboard shared with your teammate's Goal Coach app. Zoom out to the Cosmos to see everyone.

## Run

Needs Node 20+, the local Neo4j container (`hackathon`, port 7687), and the `.env` files in `server/` and `points/` (ai& key, Neo4j login, shared points key).

```bash
cd C:\Users\nowru\Documents\assistant\hackathon\north-star
npm run desktop
```

This starts the points service (:8788), the API (:8787), the web UI (:5173) and the Windows desktop app. Use `npm run dev` instead for the browser only (no focus checks).

- `npm run tunnel` exposes the points service to your teammate. It prints a `https://….trycloudflare.com` URL; give them that URL and the `POINTS_KEY` from `points/.env` privately, never in a commit.
- `npm run seed` resets the demo players (re-run on demo day so streaks are fresh).
- `npm run setup` reinstalls dependencies on a new machine. `npm run typecheck` checks the TypeScript apps.

## How it fits together

| Part | Folder | What it does |
|---|---|---|
| Web UI | `web/` | Vite + React + three.js cosmos, glass chat with voice and suggested answers |
| API | `server/` | Goals, stars and milestones in Neo4j (`NS*` labels); the interviewing and coaching agent and the screen-check judge on ai& (`zai-org/glm-5.3-flash`); local Whisper for voice |
| Desktop | `desktop/` | Electron shell for Windows; every 30 s while focusing it captures the screen (plus optional webcam frame) in memory and sends it to `POST /api/focus/check` |
| Points | `points/` | Shared multiplayer service: players, verified focus intervals, points and leaderboard (`PS*` labels). Both apps report here. See [POINTS.md](POINTS.md) |

Contracts: [CONTRACT.md](CONTRACT.md) (API), [DESKTOP.md](DESKTOP.md) (desktop bridge), [POINTS.md](POINTS.md) (points service, with a paste-ready snippet for Goal Coach).

## Voice

Click the mic in the chat box and talk. ✓ puts the transcript in the box to edit, ↑ sends it straight away, and Esc cancels. Whisper (`onnx-community/whisper-base`, multilingual, q8) runs locally inside the API: no key, no cost, about 1 s per short clip on CPU. The 76 MB model downloads once into `server/.cache/models`.

## Privacy

Screenshots and webcam frames live only in memory for a single check and are never saved or logged. Only verified minutes, your display name, color and one public goal title leave your machine (to the points service).
