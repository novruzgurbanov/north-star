# North Star

Write down what you want to reach and it appears as a little star. Add details whenever you like and it grows into a constellation.

Then North Star runs one simple loop on every star:

1. **Next up**: the AI proposes one concrete task for right now, with a duration.
2. **Focus**: a timed session on that task. The desktop app checks your screen (and, if you allow it, your camera) to verify you're on it, and roasts you a little when you drift.
3. **Recap**: the AI reads what actually happened (verified minutes, when and why you drifted), writes an honest recap, offers to light the milestone you finished, and proposes the next task.

Verified minutes brighten your stars and earn points on a shared leaderboard. Open the Cosmos to see everyone working on their goals right now, and click any constellation to see what that person is working toward.

## Run it on one machine

You need Node 20+, Docker (for Neo4j) and an [ai&](https://aiand.com) API key.

```bash
git clone https://github.com/novruzgurbanov/north-star.git
cd north-star
npm run setup
docker run -d --name north-star-neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/choose-a-password neo4j:latest
```

Copy `server/.env.example` to `server/.env` and `points/.env.example` to `points/.env`, then fill in:
- the ai& key (`AIAND_API_KEY`),
- the Neo4j password you chose,
- the same long random `POINTS_KEY` in both files.

Then:

```bash
npm run seed      # optional: the demo players for Demo mode
npm run desktop   # points service, API, web UI and the Windows desktop app
```

`npm run dev` runs the same stack without the desktop app (open http://localhost:5173 in a browser; focus checks need the desktop app). Closing the app window leaves the servers running; `npm run app` reopens it, and Ctrl-C in the terminal stops everything.

## Play together: see other people in the Cosmos

> **Live server for the Tokyo Agent Hackathon (17 Oct 2026):** `https://measured-carries-established-half.trycloudflare.com`
> Ask the team for the key. Quick-tunnel URLs change when the host restarts the tunnel; if this one is down, ask for the new one.

One machine hosts the shared **points service**. It only stores players, verified focus minutes, points and one public goal title per player. Everyone else's goals, chats and screenshots stay on their own machine.

### If you host

1. Run the app as above (`npm run desktop`).
2. In a second terminal, run `npm run tunnel`. It prints a public URL like `https://something.trycloudflare.com`. Cloudflare's free quick tunnel needs no account. The URL changes every time you restart the tunnel.
3. Send the people joining that URL and the `POINTS_KEY` from `points/.env`. Send the key privately; never post it or commit it. Without the key the service refuses every request except a health check.

### If you join with North Star

1. Set up as in "Run it on one machine", with your own ai& key and your own local Neo4j. You don't need `points/.env`.
2. In `server/.env`, set:
   ```
   POINTS_URL=https://the-host-url.trycloudflare.com
   POINTS_KEY=the key the host sent you
   ```
3. Run `npm run join`. It starts the API, the web UI and the desktop app without a local points service, so your points go straight to the host.
4. Open **Cosmos** and keep the leaderboard on **Real**: you'll see everyone connected to that host. Each verified minute you work shows up for them too.

### If you join with another app

Any app can report verified focus time with a few HTTP calls. [POINTS.md](POINTS.md) has the API and a paste-ready snippet; the teammate's macOS app (Goal Coach) uses it the same way.

### Real and Demo

The leaderboard in the Cosmos has a **Real · Demo** switch. **Real** shows only people who actually connected. **Demo** adds a seeded cast of nine players (`npm run seed` on the host), which is handy for showing a full sky on stage.

## Settings

The left bar's **Settings** page controls how the agent helps (Quiet · Balanced · Proactive), how often the desktop app checks your screen (10 s to 5 min), how strict the checks are, how spicy the roasts get (Off · Mild · Spicy, always PG and never about you personally), notifications, the camera default, suggested answers, sounds, and whether your goal title is shown in the Cosmos. See [SETTINGS.md](SETTINGS.md).

## How it fits together

| Part | Folder | What it does |
|---|---|---|
| Web UI | `web/` | Vite + React + three.js cosmos; glass chat with voice and suggested answers; left bar with Brainstorm, Stars and Settings |
| API | `server/` | Goals, milestones and details in Neo4j (`NS*` labels); the capturing and coaching agent, next-step planner, session recaps and screen-check judge on ai& (`zai-org/glm-5.3-flash`; set `CHAT_MODEL=moonshotai/kimi-k3` for ai&'s strongest model, ~10x slower); local Whisper for voice |
| Desktop | `desktop/` | Electron shell for Windows; while you focus it captures the screen (and an optional webcam frame) in memory every 20 s by default and sends it to `POST /api/focus/check`; roast notifications |
| Points | `points/` | Shared multiplayer service: players, verified focus intervals, points and leaderboard (`PS*` labels), with Real and Demo modes |

Contracts: [CONTRACT.md](CONTRACT.md) (API), [SESSIONS.md](SESSIONS.md) (focus sessions and recaps), [DESKTOP.md](DESKTOP.md) (desktop bridge), [POINTS.md](POINTS.md) (points service), [SETTINGS.md](SETTINGS.md) (settings).

## Voice

Click the mic in the chat box and talk. ✓ puts the transcript in the box to edit, ↑ sends it straight away, and Esc cancels. Whisper (`onnx-community/whisper-base`, multilingual, q8) runs locally inside the API: no key, no cost, about 1 s per short clip on CPU. The 76 MB model downloads once into `server/.cache/models`.

## Privacy

Screenshots and webcam frames live only in memory for a single check and are never saved or logged. Only verified minutes, your display name, your color and (if you allow it) one goal title leave your machine, and only to the points service you connect to.
