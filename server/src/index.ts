import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { initConstraints, run } from './db.js';
import { capture, checkFocus, coach, designPanel, editPanel, judgeProof, nextStep, recapSession, type CoachAction } from './agent.js';
import * as points from './points.js';
import { nanoid } from 'nanoid';
import * as model from './model.js';
import { cleanText, entryMinutes, logWidgets, validateEntryValues } from './panel.js';
import { getStatus, transcribe, warmUp } from './transcribe.js';
import { COUNT_CONFIDENCE, NOTIFY_ABOVE } from './types.js';
import type { AgentEvent, ChatMessage, Entry, Goal, Milestone, PanelSpec, ProofVerdict, Settings, Stats, User } from './types.js';

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

const userColorSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex color like #9effd8'),
});

const goalVisibilitySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  public: z.boolean(),
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

// ---------------------------------------------------------------------------
// Public goals on the shared cosmos (BRIEF-visibility.md)
// ---------------------------------------------------------------------------

/** Last time GET /api/users/:id kicked off a public-goal sync, per user. */
const lastPublicSyncAt = new Map<string, number>();
const PUBLIC_SYNC_INTERVAL_MS = 60_000; // the GET trigger runs at most once per 60 s per user

/**
 * Publish the user's public goals to the shared points service: at most 12,
 * oldest first so the newest goal is last, mapped to the PublicGoal shape from
 * ../POINTS.md. Fire and forget: callers use `void syncPublicGoals(...)`, it
 * never blocks a response and it never throws (fail soft, like points.ts).
 */
async function syncPublicGoals(userId: string): Promise<void> {
  try {
    const user = await model.getUser(userId);
    if (!user) return;
    const goals = await model.loadGoals(userId);
    const payload: points.PublicGoal[] = goals
      .filter((g) => g.public) // a private goal never leaves this server
      .slice(-12) // newest 12, still oldest first
      .map((g) => ({
        id: g.id,
        title: g.title.slice(0, 80),
        status: g.status,
        brightness: Math.round(g.brightness * 100) / 100,
        milestonesDone: g.milestones.filter((m) => m.done).length,
        milestonesTotal: g.milestones.length,
      }));
    const playerId = await ensurePlayer(user);
    if (!playerId) return; // points service offline; try again on the next trigger
    await points.publishGoals(playerId, payload);
  } catch (err) {
    console.warn(`[points] syncPublicGoals failed: ${err instanceof Error ? err.message : 'error'}`);
  }
}

/**
 * A goal just went private: drop the legacy leaderboard goalTitle when it is
 * that goal's title, so a private goal never stays visible over there (fail soft).
 */
async function clearLegacyTitle(user: User, title: string): Promise<void> {
  try {
    const playerId = await ensurePlayer(user);
    if (!playerId) return;
    const row = await points.getRow(playerId);
    if (row?.goalTitle === title) await points.setGoalTitle(playerId, null);
  } catch {
    // fail soft
  }
}

const focusSchema = z.object({
  userId: z.string().min(1),
  goalId: z.string().min(1),
  screen: z.string().min(100).max(6_000_000),
  camera: z.string().min(100).max(2_000_000).nullable().optional(),
  sinceSeconds: z.number().finite().min(1).max(3600),
});

const nextStepSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

const recapSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  goalId: z.string().min(1, 'goalId is required'),
  task: z.string().trim().min(1, 'task is required').max(120, 'task must be at most 120 chars'),
  plannedMinutes: z
    .number()
    .int({ message: 'plannedMinutes must be an integer' })
    .min(5, { message: 'plannedMinutes must be at least 5' })
    .max(180, { message: 'plannedMinutes must be at most 180' }),
  activeSeconds: z.number().min(0, { message: 'activeSeconds must be at least 0' }).finite(),
  verifiedSeconds: z.number().min(0, { message: 'verifiedSeconds must be at least 0' }).finite(),
  completed: z.boolean(),
  checks: z
    .array(
      z.object({
        at: z.string().min(1, 'at is required'),
        verdict: z.enum(['on_track', 'off_track', 'uncertain']),
        reason: z.string().max(200, 'reason must be at most 200 chars'),
      })
    )
    .max(200, 'checks must hold at most 200 items'),
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
  // Existing users get their public goals synced too — at most once per 60 s per
  // user (in-memory timestamp), always fire and forget.
  const last = lastPublicSyncAt.get(userId) ?? 0;
  if (Date.now() - last >= PUBLIC_SYNC_INTERVAL_MS) {
    lastPublicSyncAt.set(userId, Date.now());
    void syncPublicGoals(userId);
  }
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

// User color: updates the local user and the points player's color (fails soft).
app.patch('/api/users/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as Record<string, string>;
  const { color } = userColorSchema.parse(req.body);
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const updated = await model.setUserColor(userId, color);
  if (!updated) throw new HttpError(404, 'user not found');
  const playerId = await ensurePlayer(updated); // upsert (with the new color) when they had no player yet
  if (playerId) void points.setPlayerColor(playerId, color);
  res.json({ user: updated });
});

// Per-goal visibility: flips one goal between public and private and republishes
// the user's public goals to the shared cosmos (fire and forget, fails soft).
app.patch('/api/goals/:goalId', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const { userId, public: isPublic } = goalVisibilitySchema.parse(req.body);
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.setGoalPublic(userId, goalId, isPublic);
  if (!goal) throw new HttpError(404, 'goal not found');
  void syncPublicGoals(userId);
  // A goal that just went private must not keep its title on the leaderboard either.
  if (!isPublic) void clearLegacyTitle(user, goal.title);
  res.json({ goal });
});

// Delete a goal (and its milestones, details and sessions). Verified focus time and points stay.
app.delete('/api/goals/:goalId', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(userId, goalId);
  if (!goal) throw new HttpError(404, 'goal not found');
  await model.deleteGoal(userId, goalId);
  void syncPublicGoals(userId);
  void clearLegacyTitle(user, goal.title);
  const [goals, stats] = await Promise.all([model.loadGoals(userId), model.computeStats(userId)]);
  res.json({ goals, stats });
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
    const entryMinutesLogged: number[] = []; // minutes of the entries stored this turn
    const focusActions: CoachAction[] = []; // applied after the entries (below)
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
      if (action.type === 'log_entry') {
        // "I ran 5 km in 31 minutes": a self-reported entry on the panel's log
        const event = await logEntryFromChat(userId, goal.id, action);
        if (event) {
          events.push(event);
          if (event.type === 'entry_logged') entryMinutesLogged.push(event.entry.minutes);
        }
        continue;
      }
      if (action.type === 'log_focus') {
        focusActions.push(action);
        continue;
      }
      if (action.type === 'edit_panel' && action.instruction) {
        // "add a chart for my km": the panel editor rewrites the spec
        const event = await editPanelFromChat(userId, goal.id, action.instruction, settings);
        if (event) events.push(event);
        continue;
      }
      const event = await applyCoachAction(userId, goal.id, action);
      if (event) events.push(event);
    }
    // Focus time the coach logged for an activity it also stored as an entry (same minutes)
    // is the same time twice: skip that one. Any other focus time counts, also when an
    // entry turned out invalid and was never stored.
    for (const action of focusActions) {
      const same = entryMinutesLogged.findIndex((m) => m > 0 && Math.round(m) === clampMinutes(action.minutes));
      if (same >= 0) {
        entryMinutesLogged.splice(same, 1);
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
      // Details changed or milestones were completed/added: republish the public
      // goals so the cosmos shows the new brightness (fire and forget).
      if (
        events.some(
          (e) => e.type === 'details_updated' || e.type === 'milestone_done' || e.type === 'milestone_added'
        )
      ) {
        void syncPublicGoals(userId);
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
        public: settings.shareGoalTitle, // "share my goals" now means: new goals are public by default
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
        // Legacy single title for the leaderboard (fails soft; never while sharing
        // is off or the goal is private) — the public-goals list is synced below.
        const share = settings.shareGoalTitle && goal.public;
        const playerId = await ensurePlayer(user, share ? goal.title : undefined);
        if (playerId && share) void points.setGoalTitle(playerId, goal.title);
        // Publish the fresh goal when it is public (fire and forget, fails soft).
        void syncPublicGoals(user.id);
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
  // Brightness changed on the cosmos for public goals (fire and forget, fails soft).
  void syncPublicGoals(userId);
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
  // While sharing is off or the goal is private, never send the goal title to the points service.
  const settings = await model.getSettings(userId);
  const share = settings.shareGoalTitle && goal.public;
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
    // While shareGoalTitle is off or the goal is private, never send the goal title to the points service.
    const share = settings.shareGoalTitle && goal.public;
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

// Next up: the coach picks the ONE best task to do right now toward the goal (../SESSIONS.md).
app.post('/api/goals/:goalId/next-step', async (req: Request, res: Response) => {
  const { userId } = nextStepSchema.parse(req.body);
  const { goalId } = req.params as Record<string, string>;
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(userId, goalId);
  if (!goal) throw new HttpError(404, 'goal not found');
  const settings = await model.getSettings(userId);
  res.json(await nextStep(goal, settings));
});

// Recap: a focus session ends, the coach reads what happened and the session is saved on the goal.
// The session is saved even when the AI call fails (safe headline/summary fallbacks in the agent).
app.post('/api/sessions/recap', async (req: Request, res: Response) => {
  const body = recapSchema.parse(req.body);
  const user = await model.getUser(body.userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(body.userId, body.goalId);
  if (!goal) throw new HttpError(404, 'goal not found');
  const settings = await model.getSettings(body.userId);
  const recap = await recapSession(goal, body, settings);
  const session = await model.saveSession(body.userId, body.goalId, {
    task: body.task,
    plannedMinutes: body.plannedMinutes,
    activeSeconds: body.activeSeconds,
    verifiedSeconds: body.verifiedSeconds,
    drifts: body.checks.filter((c) => c.verdict === 'off_track').length,
    headline: recap.headline,
  });
  // A session was saved: public goals may have a new brightness (fire and forget, fails soft).
  if (session) void syncPublicGoals(body.userId);
  res.json({
    session,
    headline: recap.headline,
    summary: recap.summary,
    driftNote: recap.driftNote,
    next: recap.next,
    suggestMilestoneId: recap.suggestMilestoneId,
  });
});

// ---------------------------------------------------------------------------
// Goal panels and entries (../PANELS.md). The AI writes a declarative spec that
// src/panel.ts sanitizes; nothing the AI writes is ever executed.
// ---------------------------------------------------------------------------

const panelDesignSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  instruction: z.string().trim().max(300, 'instruction must be at most 300 chars').optional(),
});

const panelEditSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  instruction: z.string().trim().min(1, 'instruction is required').max(300, 'instruction must be at most 300 chars'),
});

const widgetOpSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  op: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('remove') }),
    z.object({
      kind: z.literal('move'),
      to: z.number().int({ message: 'to must be an integer' }).min(0, { message: 'to must be at least 0' }).max(50),
    }),
    z.object({ kind: z.literal('toggle_item'), itemId: z.string().min(1, 'itemId is required').max(40) }),
  ]),
});

const entrySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  widgetId: z.string().min(1, 'widgetId is required').max(40),
  values: z.record(z.string().max(40), z.union([z.number(), z.string().max(400), z.boolean(), z.null()])),
  note: z.string().max(300, 'note must be at most 300 chars').optional(),
  proof: z.string().max(6_000_000, 'proof image is too large').nullable().optional(), // base64 JPEG/PNG
});

const MAX_PROOF_BYTES = 4 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A base64 JPEG or PNG (raw or data URL, <= 4 MB) -> a data URL with the right type. Never logged. */
function proofDataUrl(raw: string): { url: string } | { error: string } {
  const match = /^data:image\/(?:jpeg|jpg|png);base64,/i.exec(raw);
  const b64 = (match ? raw.slice(match[0].length) : raw).replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'proof must be a base64 JPEG or PNG' };
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_PROOF_BYTES) return { error: 'proof image must be at most 4 MB' };
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_MAGIC);
  if (!isJpeg && !isPng) return { error: 'proof must be a base64 JPEG or PNG' };
  return { url: `data:image/${isPng ? 'png' : 'jpeg'};base64,${b64}` };
}

/** The user and their goal, or a 404 (every panel route checks ownership). */
async function userGoal(userId: string, goalId: string): Promise<{ user: User; goal: Goal }> {
  const user = await model.getUser(userId);
  if (!user) throw new HttpError(404, 'user not found');
  const goal = await model.getGoal(userId, goalId);
  if (!goal) throw new HttpError(404, 'goal not found');
  return { user, goal };
}

type PanelChange = { spec: PanelSpec; change: string };

/** The editor rewrites the panel (or, when the goal has none yet, the designer builds one following the instruction). */
async function rewritePanel(goal: Goal, instruction: string, settings: Settings): Promise<PanelChange | null> {
  if (!goal.panel) {
    const { spec } = await designPanel(goal, settings, instruction);
    return { spec, change: 'Designed a panel for this goal.' };
  }
  return editPanel(goal.panel, goal, instruction, settings);
}

/**
 * Make an AI change to the goal's panel and save it onto the spec it was built from. The
 * AI takes seconds: when the panel changed meanwhile (a move, a remove, another window),
 * the change is made once more on the fresh panel; ticked checklist items alone don't
 * count, they are carried over. Returns the fresh goal and change, 'failed' when the AI
 * gave nothing usable, 'conflict' when the panel moved under it twice, null when the
 * goal is gone.
 */
async function changePanel(
  userId: string,
  goal: Goal,
  make: (goal: Goal) => Promise<PanelChange | null>
): Promise<{ goal: Goal; change: string } | 'failed' | 'conflict' | null> {
  let current: Goal | null = goal;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) current = await model.getGoal(userId, goal.id);
    if (!current) return null;
    const result = await make(current);
    if (!result) return 'failed';
    const saved = await model.savePanel(userId, goal.id, result.spec, current.panel);
    if (saved === null) return null;
    if (saved !== 'conflict') return { goal: saved, change: result.change };
  }
  return 'conflict';
}

/** changePanel's outcome as the route's answer (or the HTTP error). */
function panelChanged(
  result: { goal: Goal; change: string } | 'failed' | 'conflict' | null,
  failed: string
): { goal: Goal; change: string } {
  if (result === null) throw new HttpError(404, 'goal not found');
  if (result === 'failed') throw new HttpError(502, failed);
  if (result === 'conflict') throw new HttpError(409, 'Your panel changed while I was working on it. Try again.');
  return result;
}

// A check-in's minutes are typed by the user and its photo can be sent again, so verified
// check-ins count toward score and the leaderboard up to these limits (../PANELS.md).
const CHECKIN_ENTRY_MAX_MINUTES = 180; // per entry
const CHECKIN_DAY_MAX_MINUTES = 240; // per user, in any 24 hours

/**
 * A verified entry with minutes counts like verified focus: an NSActivity (source
 * 'checkin', so the star brightens) and the time reported to the points service as
 * intervals of at most 15 minutes ending at the entry time, both within the check-in
 * caps above. Self-reported, unverified and rejected entries count only on the goal's
 * own widgets. Private goals (or sharing off) never send the title. Returns the fresh
 * points row, null when offline.
 */
async function countVerifiedEntry(user: User, goal: Goal, entry: Entry): Promise<points.PointsRow | null> {
  const counted =
    entry.proof === 'verified' && entry.minutes > 0
      ? await model.logCheckin(user.id, goal.id, Math.min(entry.minutes, CHECKIN_ENTRY_MAX_MINUTES), CHECKIN_DAY_MAX_MINUTES)
      : 0;
  if (counted <= 0) {
    return user.pointsPlayerId ? points.getRow(user.pointsPlayerId) : null;
  }
  const settings = await model.getSettings(user.id);
  const share = settings.shareGoalTitle && goal.public;
  const playerId = await ensurePlayer(user, share ? goal.title : undefined);
  let row: points.PointsRow | null = null;
  if (playerId) {
    for (const interval of points.splitInterval(entry.at, counted)) {
      const next = await points.reportFocus({
        id: nanoid(), playerId, start: interval.start, end: interval.end,
        goalTitle: share ? goal.title : undefined,
      });
      if (!next) break; // offline: don't wait out a timeout per chunk
      row = next;
    }
  }
  void syncPublicGoals(user.id); // brightness changed (fire and forget)
  return row;
}

/** Coach log_entry: a self-reported entry (proof 'none') on one of the panel's logs. */
async function logEntryFromChat(userId: string, goalId: string, action: CoachAction): Promise<AgentEvent | null> {
  const goal = await model.getGoal(userId, goalId); // fresh: an earlier action may have edited the panel
  const log = logWidgets(goal?.panel ?? null).find((l) => l.id === action.widgetId);
  if (!goal || !log) return null;
  const checked = validateEntryValues(log, action.values ?? {}, true); // lenient: "5 km" -> 5
  if (!checked.ok) return null;
  const entry = await model.addEntry(userId, goalId, {
    widgetId: log.id,
    values: checked.values,
    note: '',
    minutes: entryMinutes(log, checked.values),
    proof: 'none',
    proofReason: '',
  });
  return entry ? { type: 'entry_logged', goalId, entry } : null;
}

/** Coach edit_panel: rewrite the panel and report it as panel_updated. */
async function editPanelFromChat(
  userId: string,
  goalId: string,
  instruction: string,
  settings: Settings
): Promise<AgentEvent | null> {
  const goal = await model.getGoal(userId, goalId);
  if (!goal) return null;
  const result = await changePanel(userId, goal, (g) => rewritePanel(g, instruction, settings));
  return result && typeof result === 'object' ? { type: 'panel_updated', goalId, goal: result.goal, change: result.change } : null;
}

const describeSpec = (spec: PanelSpec | null | undefined): string =>
  spec ? `${spec.profile}: ${spec.widgets.map((w) => w.type).join(', ')}` : '(none)';

// Design a panel from scratch. The web UI calls this the first time it opens a ready goal
// without one, perhaps from two windows at once; with an instruction it is a redesign.
app.post('/api/goals/:goalId/panel/design', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const { userId, instruction } = panelDesignSchema.parse(req.body);
  const { goal } = await userGoal(userId, goalId);
  // Without an instruction an existing panel is never replaced (it holds the user's entries and ticks).
  if (goal.panel && !instruction) {
    res.json({ goal });
    return;
  }
  const settings = await model.getSettings(userId);
  if (!instruction) {
    const { spec, ai } = await designPanel(goal, settings);
    const saved = await model.savePanel(userId, goalId, spec, null);
    // 'conflict': another window designed this goal meanwhile; that panel stays.
    const fresh = saved === 'conflict' ? await model.getGoal(userId, goalId) : saved;
    if (!fresh) throw new HttpError(404, 'goal not found');
    if (saved !== 'conflict') console.log(`[panel] designed ${describeSpec(spec)}${ai ? '' : ' (fallback)'}`);
    res.json({ goal: fresh });
    return;
  }
  // A redesign in words: logs that record the same activity keep their ids, ticks carry over,
  // and an existing panel is only ever replaced by the AI's own design, never a default one.
  const result = await changePanel(userId, goal, async (g) => {
    const { spec, ai } = await designPanel(g, settings, instruction);
    return g.panel && !ai ? null : { spec, change: '' };
  });
  const { goal: fresh } = panelChanged(result, "Couldn't redesign the panel this time. Try again.");
  console.log(`[panel] redesigned ${describeSpec(fresh.panel)}`);
  res.json({ goal: fresh });
});

// Change the panel in words ("add a weekly km chart"); the previous spec stays undoable.
app.post('/api/goals/:goalId/panel/edit', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const { userId, instruction } = panelEditSchema.parse(req.body);
  const { goal } = await userGoal(userId, goalId);
  const settings = await model.getSettings(userId);
  const result = await changePanel(userId, goal, (g) => rewritePanel(g, instruction, settings));
  res.json(panelChanged(result, "Couldn't change the panel this time. Try again."));
});

app.post('/api/goals/:goalId/panel/undo', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const { userId } = z.object({ userId: z.string().min(1, 'userId is required') }).parse(req.body);
  await userGoal(userId, goalId);
  const result = await model.undoPanel(userId, goalId);
  if (result === null) throw new HttpError(404, 'goal not found');
  if (result === 'empty') throw new HttpError(409, 'nothing to undo');
  if (result === 'conflict') throw new HttpError(409, 'the panel just changed; try again');
  res.json({ goal: result });
});

// Manual edits without the AI: remove, move, toggle a checklist item. Applied to the panel
// as stored at that moment, so quick edits in a row each build on the last one.
app.patch('/api/goals/:goalId/panel/widgets/:widgetId', async (req: Request, res: Response) => {
  const { goalId, widgetId } = req.params as Record<string, string>;
  const { userId, op } = widgetOpSchema.parse(req.body);
  await userGoal(userId, goalId);
  const result = await model.applyPanelOp(userId, goalId, widgetId, op);
  if (!result.ok) throw new HttpError(result.status, result.error);
  res.json({ goal: result.goal });
});

// Log one entry in a log widget; an optional proof photo is judged by the vision model.
// The image is used in memory for that one call and never stored or logged.
app.post('/api/goals/:goalId/entries', async (req: Request, res: Response) => {
  const { goalId } = req.params as Record<string, string>;
  const body = entrySchema.parse(req.body);
  const { user, goal } = await userGoal(body.userId, goalId);
  const log = logWidgets(goal.panel).find((l) => l.id === body.widgetId);
  if (!log) throw new HttpError(404, 'log widget not found');
  const checked = validateEntryValues(log, body.values);
  if (!checked.ok) throw new HttpError(400, checked.error);

  let proof: ProofVerdict = 'none';
  let proofReason = '';
  if (body.proof) {
    const image = proofDataUrl(body.proof);
    if ('error' in image) throw new HttpError(400, image.error);
    const verdict = await judgeProof(goal, log, checked.values, image.url);
    proof = verdict.verdict;
    proofReason = verdict.reason;
    console.log(`[proof] ${verdict.verdict} ${verdict.confidence.toFixed(2)}`);
  } else if (log.proof === 'required') {
    throw new HttpError(400, 'this log needs a photo or screenshot as proof');
  }

  const entry = await model.addEntry(user.id, goal.id, {
    widgetId: log.id,
    values: checked.values,
    note: cleanText(body.note ?? '', 300),
    minutes: entryMinutes(log, checked.values),
    proof,
    proofReason,
  });
  if (!entry) throw new HttpError(404, 'goal not found');
  const row = await countVerifiedEntry(user, goal, entry);
  const [fresh, stats] = await Promise.all([model.getGoal(user.id, goal.id), model.computeStats(user.id)]);
  res.json({ entry, goal: fresh ?? goal, stats, points: row });
});

app.delete('/api/goals/:goalId/entries/:entryId', async (req: Request, res: Response) => {
  const { goalId, entryId } = req.params as Record<string, string>;
  const { userId } = z.object({ userId: z.string().min(1, 'userId is required') }).parse(req.body);
  await userGoal(userId, goalId);
  const deleted = await model.deleteEntry(userId, goalId, entryId);
  if (!deleted) throw new HttpError(404, 'entry not found');
  const [fresh, stats] = await Promise.all([model.getGoal(userId, goalId), model.computeStats(userId)]);
  res.json({ goal: fresh, stats });
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

const PORT = Number(process.env.API_PORT ?? 8887); // v2; v1 keeps 8787
const ORPHAN_SWEEP_MS = 10 * 60_000;

/** Entries whose goal is gone (v1 deletes goals without knowing about entries); never throws. */
async function sweepOrphanEntries(): Promise<void> {
  try {
    const removed = await model.sweepOrphanEntries();
    if (removed > 0) console.log(`[db] removed ${removed} entries left without a goal`);
  } catch (err) {
    console.warn(`[db] orphan entry sweep failed: ${err instanceof Error ? err.message : 'error'}`);
  }
}

async function main(): Promise<void> {
  try {
    await initConstraints();
    console.log('[db] constraints ready');
  } catch (err) {
    console.error('[db] constraint init failed:', err instanceof Error ? err.message : err);
  }
  await sweepOrphanEntries();
  setInterval(() => void sweepOrphanEntries(), ORPHAN_SWEEP_MS).unref();
  // Warm up Whisper in the background; logs when ready, never crashes boot.
  warmUp().catch(() => {});
  app.listen(PORT, () => {
    console.log(`north-star server listening on http://localhost:${PORT}`);
  });
}

void main();
