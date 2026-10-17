import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { initConstraints, run } from './db.js';
import { capture, checkFocus, coach, type CoachAction } from './agent.js';
import * as points from './points.js';
import { nanoid } from 'nanoid';
import * as model from './model.js';
import { getStatus, transcribe, warmUp } from './transcribe.js';
import { COUNT_CONFIDENCE, NOTIFY_ABOVE } from './types.js';
import type { AgentEvent, ChatMessage, Goal, Milestone, Stats, User } from './types.js';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.use(cors()); // open: the Electron pal app calls the same API
app.use(express.json({ limit: '8mb' })); // focus checks carry base64 JPEG screenshots

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const usersSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(80, 'name is too long'),
});

const chatSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  goalId: z.string().min(1).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1, 'messages must not be empty'),
});

const toggleSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

const activitySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  goalId: z.string().min(1).optional(),
  onTask: z.boolean(),
  minutes: z.number().positive({ message: 'minutes must be positive' }).finite(),
  source: z.string().trim().max(40).optional(),
});

function clampMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(600, Math.round(n)));
}

function capWords(s: string, maxWords: number, maxChars: number): string {
  return s.split(/\s+/).slice(0, maxWords).join(' ').slice(0, maxChars);
}

/** Make sure this user has a player in the shared points service; returns its id or null when offline. */
async function ensurePlayer(user: User, goalTitle?: string | null): Promise<string | null> {
  if (user.pointsPlayerId) return user.pointsPlayerId;
  const player = await points.upsertPlayer({ name: user.name, color: user.color, goalTitle: goalTitle ?? undefined });
  if (!player) return null;
  await model.setPointsPlayerId(user.id, player.id);
  user.pointsPlayerId = player.id;
  return player.id;
}

const focusSchema = z.object({
  userId: z.string().min(1),
  goalId: z.string().min(1),
  screen: z.string().min(100).max(6_000_000),
  camera: z.string().min(100).max(2_000_000).nullable().optional(),
  sinceSeconds: z.number().finite().min(1).max(3600),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/health', async (_req: Request, res: Response) => {
  let neo4jOk = false;
  try {
    await run('RETURN 1 AS ok');
    neo4jOk = true;
  } catch {
    neo4jOk = false;
  }
  const llmOk = Boolean(process.env.AIAND_API_KEY);
  res.json({ ok: true, neo4j: neo4jOk, llm: llmOk });
});

app.post('/api/users', async (req: Request, res: Response) => {
  const { name } = usersSchema.parse(req.body);
  const user = await model.upsertUser(name);
  await ensurePlayer(user);
  res.json({ user });
});

app.get('/api/users/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as Record<string, string>;
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const playerId = await ensurePlayer(user);
  const [goals, stats, row, settings] = await Promise.all([
    model.loadGoals(userId),
    model.computeStats(userId),
    playerId ? points.getRow(playerId) : Promise.resolve(null),
    model.getSettings(userId),
  ]);
  res.json({ user, goals, stats, points: row, settings });
});

app.get('/api/users/:userId/settings', async (req: Request, res: Response) => {
  const { userId } = req.params as Record<string, string>;
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  res.json({ settings: await model.getSettings(userId) });
});

app.put('/api/users/:userId/settings', async (req: Request, res: Response) => {
  const { userId } = req.params as Record<string, string>;
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const before = await model.getSettings(userId);
  const settings = await model.updateSettings(userId, req.body);
  // Sharing just turned off: wipe the goal title on the shared leaderboard (fails soft).
  if (before.shareGoalTitle && !settings.shareGoalTitle) {
    const playerId = await ensurePlayer(user);
    if (playerId) void points.setGoalTitle(playerId, null);
  }
  res.json({ settings });
});

app.post('/api/chat', async (req: Request, res: Response) => {
  const { userId, goalId, messages } = chatSchema.parse(req.body);
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const settings = await model.getSettings(userId);

  const events: AgentEvent[] = [];
  let reply: string;
  let understanding: number;
  let phase: 'discovering' | 'coaching';
  let suggestions: string[] = [];

  if (goalId) {
    // coaching: track progress on that goal (and help brainstorm stars grow)
    phase = 'coaching';
    understanding = 1; // always 1 in coaching
    const goal = await model.getGoal(userId, goalId);
    if (!goal) throw new HttpError(404, 'goal not found');
    const statusBefore = goal.status;
    let whyEmpty = !goal.why.trim(); // a motivation detail can fill an empty why
    const stats = await model.computeStats(userId);
    const result = await coach(goal, stats, messages as ChatMessage[], settings);
    reply = result.reply;
    suggestions = result.suggestions;
    for (const action of result.actions) {
      if (action.type === 'set_details') {
        if (action.why) whyEmpty = false;
        const fresh = await model.updateGoalDetails(userId, goal.id, {
          title: action.title,
          why: action.why,
          successLooksLike: action.successLooksLike,
          deadline: action.deadline,
        });
        if (fresh) events.push({ type: 'details_updated', goalId: goal.id, goal: fresh });
        continue;
      }
      if (action.type === 'add_detail' && action.kind && action.text) {
        const detail = await model.addDetail(userId, goal.id, action.kind, action.text);
        if (detail) {
          events.push({ type: 'detail_added', goalId: goal.id, detail });
          // Keep `missing` meaningful: a recorded motivation is a why.
          if (detail.kind === 'motivation' && whyEmpty) {
            await model.updateGoalDetails(userId, goal.id, { why: detail.text });
            whyEmpty = false;
          }
        }
        continue;
      }
      const event = await applyCoachAction(userId, goal.id, action);
      if (event) events.push(event);
    }
    // After all actions: a little star that grew success + steps becomes ready.
    if (result.actions.length > 0) {
      const after = await model.getGoal(userId, goal.id);
      if (statusBefore === 'brainstorm' && after?.status === 'ready') {
        events.push({ type: 'goal_ready', goalId: goal.id });
      }
    }
  } else {
    // discovering: capture the goal in one message; details come later, in that goal's chat
    phase = 'discovering';
    const result = await capture(messages as ChatMessage[], settings);
    reply = result.reply;
    suggestions = result.suggestions;
    understanding = 0; // small talk (or a failed capture) creates nothing
    if (result.isGoal && result.title) {
      const goal = await model.createGoal(userId, {
        title: result.title,
        why: '',
        successLooksLike: '',
        deadline: null,
        milestones: [],
      });
      if (goal) {
        understanding = 1; // the little star is born
        events.push({ type: 'goal_created', goal });
        // Facts the first message already carried (why it matters, what distracts, ...).
        let whyFilled = false;
        for (const d of result.details) {
          const detail = await model.addDetail(userId, goal.id, d.kind, d.text);
          if (!detail) continue;
          events.push({ type: 'detail_added', goalId: goal.id, detail });
          // Same rule as coaching: the first stated motivation becomes the goal's "why".
          if (detail.kind === 'motivation' && !whyFilled) {
            await model.updateGoalDetails(userId, goal.id, { why: detail.text });
            whyFilled = true;
          }
        }
        // Share the new goal's title with the multiplayer cosmos (fails soft; never while sharing is off).
        const share = settings.shareGoalTitle;
        const playerId = await ensurePlayer(user, share ? goal.title : undefined);
        if (playerId && share) void points.setGoalTitle(playerId, goal.title);
      }
    }
  }

  const [goals, stats] = await Promise.all([
    model.loadGoals(userId),
    model.computeStats(userId),
  ]);
  res.json({ reply, understanding, phase, events, goals, stats, suggestions });
});

async function applyCoachAction(
  userId: string,
  goalId: string,
  action: CoachAction
): Promise<AgentEvent | null> {
  if (action.type === 'complete_milestone' && action.milestoneId) {
    const milestoneId = action.milestoneId.trim();
    if (!milestoneId) return null;
    const done = await model.completeMilestone(goalId, milestoneId);
    return done ? { type: 'milestone_done', goalId, milestoneId } : null;
  }
  if (action.type === 'add_milestone' && action.title) {
    const title = capWords(action.title.trim(), 6, 80);
    if (!title) return null;
    const milestone: Milestone | null = await model.addMilestone(goalId, title);
    return milestone ? { type: 'milestone_added', goalId, milestone } : null;
  }
  if (action.type === 'log_focus') {
    const minutes = clampMinutes(action.minutes);
    if (!minutes) return null;
    await model.logActivity({ userId, goalId, onTask: true, minutes, source: 'chat' });
    return { type: 'focus_logged', goalId, minutes };
  }
  return null;
}

app.post('/api/milestones/:id/toggle', async (req: Request, res: Response) => {
  const { userId } = toggleSchema.parse(req.body);
  const { id } = req.params as Record<string, string>;
  const goal = await model.toggleMilestone(userId, id);
  if (!goal) throw new HttpError(404, 'milestone not found');
  const stats = await model.computeStats(userId);
  res.json({ goal, stats });
});

app.post('/api/activity', async (req: Request, res: Response) => {
  const body = activitySchema.parse(req.body);
  const user = await model.getUser(body.userId);
  if (!user) throw new HttpError(404, 'user not found');

  const goalId = body.goalId ?? (await model.mostRecentGoalId(body.userId));
  if (!goalId) throw new HttpError(400, 'user has no goals yet');

  const goal = await model.getGoal(body.userId, goalId);
  if (!goal) throw new HttpError(404, 'goal not found');

  const minutes = clampMinutes(body.minutes);
  if (!minutes) throw new HttpError(400, 'minutes must be positive');

  await model.logActivity({
    userId: body.userId,
    goalId,
    onTask: body.onTask,
    minutes,
    source: body.source?.trim() || 'api',
  });
  // Reload so the returned brightness includes the minutes just logged.
  const [fresh, stats] = await Promise.all([model.getGoal(body.userId, goalId), model.computeStats(body.userId)]);
  res.json({ goal: fresh ?? goal, stats });
});

app.post('/api/users/:userId/active-goal', async (req: Request, res: Response) => {
  const { userId } = req.params as Record<string, string>;
  const { goalId } = z.object({ goalId: z.string().min(1) }).parse(req.body);
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(userId, goalId);
  if (!goal) throw new HttpError(404, 'goal not found');
  // While shareGoalTitle is off, never send the goal title to the points service.
  const settings = await model.getSettings(userId);
  const share = settings.shareGoalTitle;
  const playerId = await ensurePlayer(user, share ? goal.title : undefined);
  if (playerId && share) await points.setGoalTitle(playerId, goal.title);
  const row = playerId ? await points.getRow(playerId) : null;
  res.json({ ok: true, points: row });
});

// Verified focus: the desktop app sends a screenshot (and optional webcam frame) every ~30 s.
// Images are used in memory for this one vision call and never stored or logged.
app.post('/api/focus/check', async (req: Request, res: Response) => {
  const body = focusSchema.parse(req.body);
  const user = await model.getUser(body.userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(body.userId, body.goalId);
  if (!goal) throw new HttpError(404, 'goal not found');

  const sinceSeconds = Math.min(900, Math.max(5, body.sinceSeconds));
  const started = Date.now();
  const settings = await model.getSettings(user.id);
  const verdict = await checkFocus(goal, body.screen, body.camera ?? null, settings);
  const counted = verdict.verdict === 'on_track' && verdict.confidence >= COUNT_CONFIDENCE[settings.strictness];

  let row: points.PointsRow | null = null;
  if (counted) {
    const end = new Date();
    const start = new Date(end.getTime() - sinceSeconds * 1000);
    await model.logActivity({ userId: user.id, goalId: goal.id, onTask: true, minutes: sinceSeconds / 60, source: 'desktop' });
    // While shareGoalTitle is off, never send the goal title to the points service.
    const share = settings.shareGoalTitle;
    const playerId = await ensurePlayer(user, share ? goal.title : undefined);
    if (playerId) {
      row = await points.reportFocus({
        id: nanoid(), playerId, start: start.toISOString(), end: end.toISOString(),
        goalTitle: share ? goal.title : undefined,
      });
    }
  } else if (user.pointsPlayerId) {
    row = await points.getRow(user.pointsPlayerId);
  }

  const [fresh, stats] = await Promise.all([model.getGoal(user.id, goal.id), model.computeStats(user.id)]);
  console.log(`[focus] ${verdict.verdict} ${verdict.confidence.toFixed(2)} counted=${counted ? sinceSeconds : 0}s in ${Date.now() - started}ms`);
  res.json({
    ...verdict,
    counted,
    countedSeconds: counted ? sinceSeconds : 0,
    notifyAbove: NOTIFY_ABOVE[settings.strictness],
    goal: fresh ?? goal,
    stats,
    points: row,
  });
});

app.get('/api/cosmos', async (req: Request, res: Response) => {
  const { rows, offline } = await points.leaderboard(req.query.mode === 'demo' ? 'demo' : 'real');
  res.json({ players: rows, offline });
});

app.get('/api/leaderboard', async (req: Request, res: Response) => {
  res.json(await points.leaderboard(req.query.mode === 'demo' ? 'demo' : 'real'));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    const message =
      err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') || 'invalid request body';
    res.status(400).json({ error: message });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }
  const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
  const message = err instanceof Error ? err.message : 'internal error';
  if (status >= 500) console.error('[error]', message);
  res.status(status >= 400 ? status : 500).json({ error: message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = Number(process.env.API_PORT ?? 8787);

async function main(): Promise<void> {
  try {
    await initConstraints();
    console.log('[db] constraints ready');
  } catch (err) {
    console.error('[db] constraint init failed:', err instanceof Error ? err.message : err);
  }
  // Warm up Whisper in the background; logs when ready, never crashes boot.
  warmUp().catch(() => {});
  app.listen(PORT, () => {
    console.log(`north-star server listening on http://localhost:${PORT}`);
  });
}

void main();
