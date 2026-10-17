# Brief: North Star backend

You are building the backend for **North Star**, a hackathon app (demo in ~3 hours). A user chats with an AI agent that asks questions until it understands their goal. The goal then appears as a star in a 3D cosmos, and its milestones appear as smaller stars around it. Users earn score by working on their goals. A leaderboard shows everyone.

Work ONLY inside this folder: `C:\Users\nowru\Documents\assistant\hackathon\north-star\server`. Do not touch anything outside it. Do not print or log the contents of `.env`.

The API contract is in `../CONTRACT.md`. Read it first and follow it exactly: paths, body shapes, response shapes, and scoring formulas. The frontend is being written against it in parallel.

## Stack (already installed, see package.json)

- Node 24, TypeScript, run with `tsx` (`npm run dev` = `tsx watch src/index.ts`). ESM (`"type": "module"`).
- `express` v5, `cors`, `dotenv`, `neo4j-driver`, `openai`, `zod`, `nanoid`.
- `.env` already exists with `AIAND_API_KEY`, `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `CHAT_MODEL`, `PORT=8787`.
- LLM: OpenAI-compatible client with `baseURL: "https://api.aiand.com/v1"`, `apiKey: process.env.AIAND_API_KEY`, model `process.env.CHAT_MODEL` (default `zai-org/glm-5.3-flash`).
- Neo4j: `neo4j.driver(NEO4J_URI, neo4j.auth.basic(user, pass))`, database `neo4j`. A Neo4j container is running locally. Other projects use the same database, so **only touch nodes with the labels below**. Convert Neo4j Integers to JS numbers in responses.

## Files to create

```
src/index.ts      express app, routes, CORS open, JSON body limit 1mb, error handler returning {error}
src/db.ts         driver, constraints (unique id on NSUser/NSGoal/NSMilestone), query helpers
src/model.ts      loadGoals(userId), computeStats(userId), brightness math, toGoal() mapping
src/agent.ts      discover() and coach() LLM calls, JSON parsing, fallbacks
src/seed.ts       `npm run seed`: delete seeded users (and their goals/milestones/activity), create demo users
```

## Graph model (prefix every label with NS so we never collide with other data)

```
(:NSUser {id, name, nameLower, color, seeded, createdAt})
(:NSUser)-[:PURSUES]->(:NSGoal {id, title, why, successLooksLike, deadline, createdAt})
(:NSGoal)-[:HAS_MILESTONE]->(:NSMilestone {id, title, done, order, doneAt})
(:NSMilestone)-[:NEXT]->(:NSMilestone)          // chain in order, for constellation lines
(:NSUser)-[:LOGGED]->(:NSActivity {id, minutes, onTask, source, at})-[:FOR]->(:NSGoal)
```

Brightness, stats and score are computed on read (formulas in CONTRACT.md); don't store them.
User color: pick from `['#8ecbff','#ffd59e','#c9a7ff','#9effd8','#ff9ec4','#fff3b0','#a7c4ff','#ffb38a']` by hash of name.

## The agent (src/agent.ts)

Both calls use `response_format: { type: "json_object" }` if the API accepts it; otherwise parse the first `{...}` block from the text. On any LLM or parse failure, retry once, then fall back to a safe reply (`"Tell me a bit more about that?"`, understanding unchanged) instead of throwing a 500. Temperature 0.6. Send the full chat history as messages after the system prompt.

### discover(messages) → { reply, understanding, ready, goal? }

Use this system prompt verbatim:

```
You are North Star, a warm, curious guide who helps a person find and name the goal they want to reach.
The interface shows a dark, empty universe. Once you truly understand their goal, a star is born for it.

How to talk:
- Ask ONE short question at a time (max 2 sentences). No lists, no bullet points, no emojis.
- Reflect back what you heard in a few words before asking, so they feel understood.
- Be specific and human, never generic. Use their words.
- Reply in the language the user writes in.

What you need to understand before the star can be born:
1. WHAT they want to reach, concretely.
2. WHY it matters to them personally.
3. What SUCCESS looks like (how they will know they made it).
4. WHEN: a deadline or time horizon (accept "no deadline" if they insist).
5. Where they are NOW and what has been in the way.

Track "understanding" from 0.0 to 1.0: how well you know all five. Raise it gradually, about 0.15-0.25 per good answer.
Only when understanding >= 0.85 AND you know at least WHAT, WHY and SUCCESS, set "ready": true and compile the goal.
Never set ready on the first user message. Usually 3-7 questions are needed.

When ready, your reply should be a short, warm sentence that names their goal back to them (the star appears as you say it).
Milestones: 3-6 concrete, ordered steps from where they are now to success. Each title max 6 words, starting with a verb.

Respond with ONLY a JSON object:
{"reply": string, "understanding": number, "ready": boolean,
 "goal": null | {"title": string (max 6 words), "why": string (1 sentence), "successLooksLike": string (1 sentence),
                 "deadline": string | null (ISO date if known, else a short phrase or null), "milestones": string[]}}
```

When `ready` and `goal` is valid: create NSGoal + NSMilestones (+ NEXT chain) for the user and emit a `goal_created` event with the full Goal. Clamp understanding to [0,1], never let it decrease between turns (take max with what the previous assistant turn implied is fine to skip; just clamp). If `ready` with understanding < 0.85, force understanding to 1 anyway when creating the goal.

### coach(goal, stats, messages) → { reply, actions }

System prompt (fill in the JSON of the goal with milestone ids and done flags, and today's date):

```
You are North Star, a warm, honest accountability coach. The user's goal is a star in their sky; each milestone is a smaller star that lights up when done.
Goal (JSON): {GOAL_JSON}
Today: {TODAY}. Their stats: {STATS_JSON}

Your job: keep track of their progress like a good accountant of effort.
- When the user says they finished a milestone, mark it done.
- When they describe work they did with a duration, log focus minutes (only time they say they actually spent).
- If they discover a missing step, add a milestone.
- Then reply in 1-3 short sentences: acknowledge concretely, then one question or nudge toward the next undone milestone. No lists, no emojis. Reply in the user's language.
- Never invent progress the user did not report.

Respond with ONLY a JSON object:
{"reply": string,
 "actions": [ {"type":"complete_milestone","milestoneId": string}
            | {"type":"add_milestone","title": string}
            | {"type":"log_focus","minutes": number} ]}
```

Apply actions server-side, validating ids belong to that goal and the user (ignore invalid ones). `log_focus` creates an NSActivity with `source: "chat"`, `onTask: true`, minutes clamped to 1..600. Map each applied action to the AgentEvent types in the contract.

`POST /api/chat` returns `{ reply, understanding, phase, events, goals, stats }` where `goals` is the user's full, fresh goal list.

## Seed (src/seed.ts, `npm run seed`)

Delete all `NSUser {seeded:true}` and everything hanging off them, then create 9 demo users with realistic, varied, non-political goals, each with 1-2 goals, 3-6 milestones, a mix of done/undone, and NSActivity spread over the last 10 days so scores range roughly 80 to 1400 and streaks 0 to 9. Examples of vibe: "Run a half marathon", "Ship my indie game demo", "Pass JLPT N3", "Learn to play Clair de Lune", "Launch a ceramics shop", "Read 24 books this year", "Get my first ML internship", "Cook through a Japanese cookbook", "Finish my thesis draft". Names: Aiko, Marcus, Lena, Ravi, Sofia, Kenji, Amara, Tom, Mei. Deterministic (no randomness that changes between runs is fine, but seeded RNG preferred).

## Acceptance checks (run them yourself)

1. `npx tsc --noEmit` passes (create a tsconfig.json: strict, module/moduleResolution NodeNext or Bundler, target ES2022, noEmit).
2. `npm run seed` succeeds against the local Neo4j.
3. Start the server in the background, then with curl: `/api/health` returns ok; `/api/leaderboard` returns 9 seeded rows sorted by score; `/api/cosmos` returns users with goals; `POST /api/users {"name":"Test"}` then `POST /api/chat` with one user message returns a question and understanding < 0.5; `POST /api/activity` raises that user's score once they have a goal. Stop the server when done. Delete the Test user's data afterwards.
4. Do not commit (there is no git repo). Do not modify `.env`, `package.json` dependencies or anything outside this folder, except you may add scripts to package.json.

When finished, write a short `DONE.md` here: what you built, how to run it, and anything that did not work.
