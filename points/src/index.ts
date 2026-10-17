// Shared points service — see ../POINTS.md for the API contract.
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { closeDb, initDb, run } from './db.js';
import { computeStats, defaultColor, rankRows } from './stats.js';
import type { RawInterval, Stats } from './stats.js';

const PORT = Number(process.env.POINTS_PORT ?? 8788);
const KEY = process.env.POINTS_KEY ?? '';
if (!KEY) {
  console.error('POINTS_KEY is not set; refusing to start');
  process.exit(1);
}

interface Player {
  id: string;
  name: string;
  color: string;
  goalTitle: string | null;
  createdAt: string;
}

interface PublicGoal {
  id: string;
  title: string;
  status: 'brainstorm' | 'ready';
  brightness: number;
  milestonesDone: number;
  milestonesTotal: number;
}

type Row = Player & Stats & { goals: PublicGoal[]; rank: number };

// ---------- validation ----------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

const nameSchema = z.string().trim().min(1).max(32);
const goalTitleSchema = z.string().trim().max(80);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB');
const sourceSchema = z.string().regex(/^[a-z0-9-]{1,24}$/, 'source must be 1-24 chars of a-z, 0-9, -');
const isoSchema = z
  .string()
  .refine(v => ISO_RE.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 timestamp');

const createPlayerSchema = z.object({
  name: nameSchema,
  color: colorSchema.optional(),
  goalTitle: goalTitleSchema.nullable().optional(),
});

const patchPlayerSchema = z.object({
  color: colorSchema.optional(),
  goalTitle: goalTitleSchema.nullable().optional(),
});

const focusSchema = z.object({
  id: z.string().trim().min(1).max(128),
  playerId: z.string().trim().min(1).max(64),
  source: sourceSchema,
  start: isoSchema,
  end: isoSchema,
  goalTitle: goalTitleSchema.nullable().optional(),
});

const publicGoalSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(80),
    status: z.enum(['brainstorm', 'ready']),
    brightness: z.number().min(0).max(1),
    milestonesDone: z.number().int().min(0).max(100),
    milestonesTotal: z.number().int().min(0).max(100),
  })
  .refine(g => g.milestonesDone <= g.milestonesTotal, {
    message: 'milestonesDone must be <= milestonesTotal',
  });

const putGoalsSchema = z.object({
  goals: z.array(publicGoalSchema).max(12),
});

// ---------- helpers ----------

const PLAYER_PROJECTION = '{.id, .name, .color, .goalTitle, .createdAt}';
const INTERVAL_PROJECTION = '{.source, .start, .end}';
const GOAL_PROJECTION =
  '{.goalId, .title, .status, .brightness, .milestonesDone, .milestonesTotal, .ord}';

function toPlayer(value: unknown): Player {
  const p = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(p.id),
    name: String(p.name),
    color: String(p.color),
    goalTitle: p.goalTitle == null ? null : String(p.goalTitle),
    createdAt: String(p.createdAt),
  };
}

/** Convert the collected PSGoal projections into PublicGoals ordered by ord. */
function toGoals(value: unknown): PublicGoal[] {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item): PublicGoal & { ord: number } => {
      const g = (item ?? {}) as Record<string, unknown>;
      return {
        id: String(g.goalId),
        title: String(g.title),
        status: g.status === 'brainstorm' ? 'brainstorm' : 'ready',
        brightness: Number(g.brightness),
        milestonesDone: Number(g.milestonesDone),
        milestonesTotal: Number(g.milestonesTotal),
        ord: Number(g.ord),
      };
    })
    .sort((a, b) => a.ord - b.ord)
    .map(({ ord: _ord, ...goal }) => goal);
}

/** Constant-time comparison of the provided header against the shared key. */
function keysMatch(provided: string | undefined): boolean {
  const a = createHash('sha256').update(provided ?? '', 'utf8').digest();
  const b = createHash('sha256').update(KEY, 'utf8').digest();
  return timingSafeEqual(a, b);
}

type Mode = 'real' | 'demo';

/** A player's row ranked among real players, or among everyone for a seeded demo player. */
async function findRow(playerId: string): Promise<Row | undefined> {
  const now = Date.now();
  return (await loadRows(now, 'real')).find(r => r.id === playerId)
    ?? (await loadRows(now, 'demo')).find(r => r.id === playerId);
}

/**
 * Load players with their intervals, compute stats, sort and rank.
 * 'real' (default) is only people who actually connected; 'demo' also includes the seeded cast.
 */
async function loadRows(now: number, mode: Mode = 'real'): Promise<Row[]> {
  const records = await run(
    `MATCH (p:PSPlayer)
     WHERE $mode = 'demo' OR coalesce(p.seeded, false) = false
     OPTIONAL MATCH (p)-[:LOGGED]->(i:PSInterval)
     WITH p, collect(i ${INTERVAL_PROJECTION}) AS intervals
     OPTIONAL MATCH (p)-[:SHARES]->(g:PSGoal)
     RETURN p ${PLAYER_PROJECTION} AS player, intervals,
            collect(g ${GOAL_PROJECTION}) AS goals`,
    { mode },
  );
  const rows = records.map(r => ({
    ...toPlayer(r.player),
    ...computeStats(r.intervals as RawInterval[], now),
    goals: toGoals(r.goals),
  }));
  return rankRows(rows);
}

// ---------- app ----------

const app = express();
app.use(cors());
app.use(express.json());

// Health is the only open endpoint.
app.get('/v1/health', (_req, res) => {
  res.json({ ok: true });
});

// Everything below requires the shared key.
app.use((req, res, next) => {
  if (!keysMatch(req.header('x-points-key'))) {
    res.status(401).json({ error: 'missing or invalid x-points-key header' });
    return;
  }
  next();
});

app.post('/v1/players', async (req, res) => {
  const body = createPlayerSchema.parse(req.body);
  const name = body.name; // already trimmed by zod
  const nameLower = name.toLowerCase();
  const goalTitleGiven = body.goalTitle !== undefined;
  const records = await run(
    `MERGE (p:PSPlayer {nameLower: $nameLower})
     ON CREATE SET p.id = $id, p.name = $name, p.seeded = false, p.createdAt = $createdAt,
                   p.color = $color, p.goalTitle = $goalTitle
     ON MATCH SET  p.color = CASE WHEN $colorGiven THEN $color ELSE p.color END,
                   p.goalTitle = CASE WHEN $goalTitleGiven THEN $goalTitle ELSE p.goalTitle END
     RETURN p ${PLAYER_PROJECTION} AS player`,
    {
      nameLower,
      id: nanoid(),
      name,
      color: body.color ?? defaultColor(nameLower),
      colorGiven: body.color !== undefined,
      goalTitle: goalTitleGiven ? body.goalTitle : null,
      goalTitleGiven,
      createdAt: new Date().toISOString(),
    },
  );
  res.json({ player: toPlayer(records[0].player) });
});

app.patch('/v1/players/:id', async (req, res) => {
  const body = patchPlayerSchema.parse(req.body ?? {});
  const id = String(req.params.id);
  const goalTitleGiven = body.goalTitle !== undefined;
  const records = await run(
    `MATCH (p:PSPlayer {id: $id})
     SET p.color = CASE WHEN $colorGiven THEN $color ELSE p.color END,
         p.goalTitle = CASE WHEN $goalTitleGiven THEN $goalTitle ELSE p.goalTitle END
     RETURN p ${PLAYER_PROJECTION} AS player`,
    {
      id,
      color: body.color ?? null,
      colorGiven: body.color !== undefined,
      goalTitle: goalTitleGiven ? body.goalTitle : null,
      goalTitleGiven,
    },
  );
  if (records.length === 0) {
    res.status(404).json({ error: 'player not found' });
    return;
  }
  res.json({ player: toPlayer(records[0].player) });
});

app.get('/v1/players/:id', async (req, res) => {
  const id = String(req.params.id);
  const row = await findRow(id);
  if (!row) {
    res.status(404).json({ error: 'player not found' });
    return;
  }
  res.json({ row });
});

// Replace the player's whole public goal list in one transaction: delete the
// existing PSGoal nodes, then create the submitted ones (ord = array index).
app.put('/v1/players/:id/goals', async (req, res) => {
  const body = putGoalsSchema.parse(req.body ?? {});
  const id = String(req.params.id);
  const seen = new Set<string>();
  for (const goal of body.goals) {
    if (seen.has(goal.id)) {
      res.status(400).json({ error: `duplicate goal id: ${goal.id}` });
      return;
    }
    seen.add(goal.id);
  }

  const found = await run('MATCH (p:PSPlayer {id: $id}) RETURN 1 AS found', { id });
  if (found.length === 0) {
    res.status(404).json({ error: 'player not found' });
    return;
  }

  await run(
    `MATCH (p:PSPlayer {id: $id})
     OPTIONAL MATCH (p)-[:SHARES]->(old:PSGoal)
     WITH p, collect(old) AS olds
     FOREACH (o IN olds | DETACH DELETE o)
     WITH p
     UNWIND $goals AS g
     MERGE (goal:PSGoal {key: p.id + ':' + g.id})
     SET goal.goalId = g.id, goal.title = g.title, goal.status = g.status,
         goal.brightness = g.brightness, goal.milestonesDone = g.milestonesDone,
         goal.milestonesTotal = g.milestonesTotal, goal.ord = g.ord,
         goal.updatedAt = $updatedAt
     MERGE (p)-[:SHARES]->(goal)`,
    {
      id,
      updatedAt: new Date().toISOString(),
      goals: body.goals.map((goal, ord) => ({
        id: goal.id,
        title: goal.title,
        status: goal.status,
        brightness: goal.brightness,
        milestonesDone: goal.milestonesDone,
        milestonesTotal: goal.milestonesTotal,
        ord,
      })),
    },
  );

  const row = await findRow(id);
  if (!row) {
    res.status(404).json({ error: 'player not found' });
    return;
  }
  res.json({ row });
});

app.post('/v1/focus', async (req, res) => {
  const body = focusSchema.parse(req.body);
  const startMs = Date.parse(body.start);
  const endMs = Date.parse(body.end);
  const now = Date.now();
  const duration = endMs - startMs;
  if (!(duration >= 5_000)) {
    res.status(400).json({ error: 'end - start must be at least 5 seconds' });
    return;
  }
  if (duration > 900_000) {
    res.status(400).json({ error: 'end - start must be at most 15 minutes' });
    return;
  }
  if (endMs > now + 60_000) {
    res.status(400).json({ error: 'end may not be more than 60 seconds in the future' });
    return;
  }
  if (startMs < now - 48 * 3_600_000) {
    res.status(400).json({ error: 'start may not be older than 48 hours' });
    return;
  }

  const found = await run(
    `MATCH (p:PSPlayer {id: $playerId})
     OPTIONAL MATCH (i:PSInterval {id: $id})<-[:LOGGED]-(owner:PSPlayer)
     RETURN p ${PLAYER_PROJECTION} AS player, owner.id AS ownerId`,
    { playerId: body.playerId, id: body.id },
  );
  if (found.length === 0) {
    res.status(404).json({ error: 'player not found' });
    return;
  }

  // MERGE on the interval id makes a retried POST a no-op. If the id is already
  // owned by a different player, treat it the same way: no write.
  const ownerId = typeof found[0].ownerId === 'string' ? found[0].ownerId : null;
  if (ownerId === null || ownerId === body.playerId) {
    const goalTitleGiven = body.goalTitle !== undefined;
    await run(
      `MATCH (p:PSPlayer {id: $playerId})
       MERGE (i:PSInterval {id: $id})
       ON CREATE SET i.source = $source, i.start = $start, i.end = $end, i.createdAt = $createdAt
       MERGE (p)-[:LOGGED]->(i)
       SET p.goalTitle = CASE WHEN $goalTitleGiven THEN $goalTitle ELSE p.goalTitle END`,
      {
        playerId: body.playerId,
        id: body.id,
        source: body.source,
        start: body.start,
        end: body.end,
        createdAt: new Date().toISOString(),
        goalTitle: goalTitleGiven ? body.goalTitle : null,
        goalTitleGiven,
      },
    );
  }

  const row = await findRow(body.playerId);
  if (!row) {
    res.status(404).json({ error: 'player not found' });
    return;
  }
  res.json({ row });
});

app.get('/v1/leaderboard', async (req, res) => {
  const mode: Mode = req.query.mode === 'demo' ? 'demo' : 'real';
  res.json({ rows: await loadRows(Date.now(), mode), mode });
});

// Unknown paths get JSON, not the HTML default.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    const detail = err.issues
      .map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(': '))
      .join('; ');
    res.status(400).json({ error: `invalid request: ${detail}` });
    return;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  ) {
    res.status(400).json({ error: 'request body is not valid JSON' });
    return;
  }
  console.error('[points] unhandled error:', err);
  res.status(500).json({ error: 'internal server error' });
});

await initDb();
const server = app.listen(PORT, () => {
  console.log(`points service listening on port ${PORT}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await closeDb();
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
