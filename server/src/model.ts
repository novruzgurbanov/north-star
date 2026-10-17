import { nanoid } from 'nanoid';
import { z } from 'zod';
import { run, toNum } from './db.js';
import { DEFAULT_SETTINGS, DETAIL_KINDS, type Goal, type GoalDetail, type DetailKind, type Milestone, type NewGoal, type Settings, type Stats, type User } from './types.js';

export const COLORS = ['#8ecbff', '#ffd59e', '#c9a7ff', '#9effd8', '#ff9ec4', '#fff3b0', '#a7c4ff', '#ffb38a'];

const nowIso = (): string => new Date().toISOString();
const newId = (): string => nanoid(12);

/** Pick a user color from the palette by hashing their name. */
export function userColor(name: string): string {
  const key = name.toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ---------------------------------------------------------------------------
// Brightness (computed on read, never stored)
// ---------------------------------------------------------------------------

export function milestoneBrightness(done: boolean): number {
  return done ? 1 : 0.18;
}

/** min(1, 0.25 + 0.6 * doneFraction + min(0.15, focusedMinutes_on_goal / 60 * 0.03)) */
export function goalBrightness(doneCount: number, total: number, focusMinutes: number): number {
  const doneFraction = total > 0 ? doneCount / total : 0;
  const focusBonus = Math.min(0.15, (focusMinutes / 60) * 0.03);
  return Math.min(1, 0.25 + 0.6 * doneFraction + focusBonus);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapUser(u: Record<string, unknown>): User {
  return {
    id: String(u.id),
    name: String(u.name ?? ''),
    color: String(u.color ?? COLORS[0]),
    seeded: Boolean(u.seeded),
    pointsPlayerId: u.pointsPlayerId ? String(u.pointsPlayerId) : null,
  };
}

function mapDetail(d: Record<string, unknown>): GoalDetail {
  const kind = String(d.kind ?? '') as DetailKind;
  return {
    id: String(d.id),
    kind: (DETAIL_KINDS as readonly string[]).includes(kind) ? kind : 'action',
    text: String(d.text ?? ''),
    createdAt: String(d.createdAt ?? ''),
  };
}

export function toGoal(
  g: Record<string, unknown>,
  milestones: Array<Record<string, unknown>>,
  focusMinutes: number,
  details: Array<Record<string, unknown>> = []
): Goal {
  const ms: Milestone[] = milestones
    .map((m) => ({
      id: String(m.id),
      title: String(m.title ?? ''),
      done: Boolean(m.done),
      order: toNum(m.order),
      brightness: milestoneBrightness(Boolean(m.done)),
    }))
    .sort((a, b) => a.order - b.order);
  const doneCount = ms.filter((m) => m.done).length;
  const why = String(g.why ?? '');
  const successLooksLike = String(g.successLooksLike ?? '');
  const deadline = g.deadline == null ? null : String(g.deadline);
  // ready = successLooksLike non-empty AND at least one milestone
  const ready = successLooksLike.trim().length > 0 && ms.length >= 1;
  const missing: Goal['missing'] = [];
  if (!successLooksLike.trim()) missing.push('success');
  if (ms.length === 0) missing.push('steps');
  if (!why.trim()) missing.push('why');
  let brightness: number;
  if (ready) {
    brightness = goalBrightness(doneCount, ms.length, focusMinutes);
  } else {
    // little brainstorm star: 0.12 + 0.04 * filled among why, successLooksLike, deadline, >=1 milestone
    let filled = 0;
    if (why.trim()) filled++;
    if (successLooksLike.trim()) filled++;
    if (deadline && deadline.trim()) filled++;
    if (ms.length >= 1) filled++;
    brightness = 0.12 + 0.04 * filled;
  }
  return {
    id: String(g.id),
    title: String(g.title ?? ''),
    why,
    successLooksLike,
    deadline,
    status: ready ? 'ready' : 'brainstorm',
    missing,
    brightness,
    createdAt: String(g.createdAt ?? ''),
    milestones: ms,
    details: details
      .map(mapDetail)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------
// Streak (local calendar days; consecutive days ending today or yesterday)
// ---------------------------------------------------------------------------

function localDayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function dayKeyAgo(offsetDays: number): number {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return localDayKey(d);
}

/** streak = consecutive days, ending today or yesterday, with on-task activity or a milestone completion. */
export function computeStreak(times: Array<string | null | undefined>): number {
  const days = new Set<number>();
  for (const t of times) {
    if (typeof t !== 'string') continue;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) days.add(localDayKey(d));
  }
  let start: number;
  if (days.has(dayKeyAgo(0))) start = 0;
  else if (days.has(dayKeyAgo(1))) start = 1;
  else return 0;
  let streak = 0;
  for (let off = start; days.has(dayKeyAgo(off)); off++) streak++;
  return streak;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Upsert by case-insensitive name among non-seeded users. */
export async function upsertUser(name: string): Promise<User> {
  const trimmed = name.trim();
  const nameLower = trimmed.toLowerCase();
  const existing = await run(
    'MATCH (u: NSUser {nameLower: $nameLower}) WHERE u.seeded = false RETURN u {.*} AS user LIMIT 1',
    { nameLower }
  );
  if (existing.length > 0) return mapUser(existing[0].user as Record<string, unknown>);

  const props = {
    id: newId(),
    name: trimmed,
    nameLower,
    color: userColor(trimmed),
    seeded: false,
    createdAt: nowIso(),
  };
  await run('CREATE (u: NSUser $props)', { props });
  return mapUser(props);
}

export async function setPointsPlayerId(userId: string, playerId: string): Promise<void> {
  await run('MATCH (u: NSUser {id: $userId}) SET u.pointsPlayerId = $playerId', { userId, playerId });
}

export async function getUser(userId: string): Promise<User | null> {
  const rows = await run('MATCH (u: NSUser {id: $userId}) RETURN u {.*} AS user', { userId });
  return rows.length > 0 ? mapUser(rows[0].user as Record<string, unknown>) : null;
}

export async function getAllUsers(): Promise<User[]> {
  const rows = await run('MATCH (u: NSUser) RETURN u {.*} AS user ORDER BY u.createdAt');
  return rows.map((r) => mapUser(r.user as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Per-user settings (../SETTINGS.md; stored as a JSON string on NSUser)
// ---------------------------------------------------------------------------

/** Exact enums, checkSeconds integer 10..300, booleans — anything else is a 400. */
export const settingsSchema = z.object({
  helpfulness: z.enum(['quiet', 'balanced', 'proactive']),
  checkSeconds: z
    .number()
    .int({ message: 'checkSeconds must be an integer' })
    .min(10, { message: 'checkSeconds must be at least 10' })
    .max(300, { message: 'checkSeconds must be at most 300' }),
  strictness: z.enum(['relaxed', 'normal', 'strict']),
  roast: z.enum(['off', 'mild', 'spicy']),
  notifications: z.boolean(),
  cameraByDefault: z.boolean(),
  suggestions: z.boolean(),
  sounds: z.boolean(),
  shareGoalTitle: z.boolean(),
});

const settingsUpdateSchema = settingsSchema.partial();

/**
 * Defaults merged with what is stored: unknown keys dropped, invalid values
 * replaced by their defaults.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const result = settingsSchema.shape[key].safeParse(o[key]);
    if (result.success) (out as Record<string, unknown>)[key] = result.data;
  }
  return out;
}

/** Stored settings merged with defaults; nothing stored (or corrupt) -> defaults. */
export async function getSettings(userId: string): Promise<Settings> {
  const rows = await run('MATCH (u: NSUser {id: $userId}) RETURN u.settings AS settings', { userId });
  const raw = rows[0]?.settings;
  if (typeof raw !== 'string') return { ...DEFAULT_SETTINGS };
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Validate a partial update with zod, merge over the stored settings, save, return the full settings. */
export async function updateSettings(userId: string, partial: unknown): Promise<Settings> {
  const parsed = settingsUpdateSchema.parse(partial ?? {});
  const patch = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v !== undefined)
  ) as Partial<Settings>;
  const merged: Settings = { ...(await getSettings(userId)), ...patch };
  await run('MATCH (u: NSUser {id: $userId}) SET u.settings = $json', {
    userId,
    json: JSON.stringify(merged),
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export async function loadGoals(userId: string): Promise<Goal[]> {
  const rows = await run(
    `MATCH (u: NSUser {id: $userId})-[:PURSUES]->(g: NSGoal)
     OPTIONAL MATCH (g)-[:HAS_MILESTONE]->(m: NSMilestone)
     WITH g, collect(m {.*}) AS ms
     OPTIONAL MATCH (g)-[:HAS_DETAIL]->(d: NSDetail)
     WITH g, ms, collect(d {.*}) AS ds
     OPTIONAL MATCH (a: NSActivity)-[:FOR]->(g)
     WHERE a.onTask = true
     WITH g, ms, ds, coalesce(sum(a.minutes), 0) AS focus
     RETURN g {.*} AS goal, ms, ds, focus
     ORDER BY g.createdAt`,
    { userId }
  );
  return rows.map((r) =>
    toGoal(
      r.goal as Record<string, unknown>,
      (r.ms as Array<Record<string, unknown>>) ?? [],
      toNum(r.focus),
      (r.ds as Array<Record<string, unknown>>) ?? []
    )
  );
}

export async function getGoal(userId: string, goalId: string): Promise<Goal | null> {
  const rows = await run(
    `MATCH (:NSUser {id: $userId})-[:PURSUES]->(g: NSGoal {id: $goalId})
     OPTIONAL MATCH (g)-[:HAS_MILESTONE]->(m: NSMilestone)
     WITH g, collect(m {.*}) AS ms
     OPTIONAL MATCH (g)-[:HAS_DETAIL]->(d: NSDetail)
     WITH g, ms, collect(d {.*}) AS ds
     OPTIONAL MATCH (a: NSActivity)-[:FOR]->(g)
     WHERE a.onTask = true
     WITH g, ms, ds, coalesce(sum(a.minutes), 0) AS focus
     RETURN g {.*} AS goal, ms, ds, focus`,
    { userId, goalId }
  );
  if (rows.length === 0) return null;
  return toGoal(
    rows[0].goal as Record<string, unknown>,
    (rows[0].ms as Array<Record<string, unknown>>) ?? [],
    toNum(rows[0].focus),
    (rows[0].ds as Array<Record<string, unknown>>) ?? []
  );
}

export async function goalBelongsToUser(userId: string, goalId: string): Promise<boolean> {
  const rows = await run(
    'MATCH (:NSUser {id: $userId})-[:PURSUES]->(:NSGoal {id: $goalId}) RETURN count(*) AS c',
    { userId, goalId }
  );
  return toNum(rows[0]?.c) > 0;
}

export async function mostRecentGoalId(userId: string): Promise<string | null> {
  const rows = await run(
    `MATCH (:NSUser {id: $userId})-[:PURSUES]->(g: NSGoal)
     RETURN g.id AS id
     ORDER BY g.createdAt DESC
     LIMIT 1`,
    { userId }
  );
  return rows.length > 0 ? String(rows[0].id) : null;
}

/** Create NSGoal + NSMilestones (+ NEXT chain) for the user. Returns the fresh Goal. Accepts zero milestones. */
export async function createGoal(userId: string, def: NewGoal): Promise<Goal | null> {
  const titles = def.milestones.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 6);
  const goalId = newId();
  const createdAt = nowIso();
  const ids = titles.map(() => newId());
  const items = titles.map((title, i) => ({
    id: ids[i],
    title,
    idx: i,
    prev: i > 0 ? ids[i - 1] : null,
  }));
  const created = await run(
    `MATCH (u: NSUser {id: $userId})
     CREATE (g: NSGoal {
       id: $goalId, title: $title, why: $why, successLooksLike: $successLooksLike,
       deadline: $deadline, createdAt: $createdAt
     })
     CREATE (u)-[:PURSUES]->(g)
     WITH g
     UNWIND $items AS item
     CREATE (m: NSMilestone {id: item.id, title: item.title, done: false, \`order\`: item.idx, doneAt: null})
     CREATE (g)-[:HAS_MILESTONE]->(m)
     WITH g, item, m
     WHERE item.prev IS NOT NULL
     MATCH (prev: NSMilestone {id: item.prev})
     CREATE (prev)-[:NEXT]->(m)`,
    {
      userId,
      goalId,
      title: def.title,
      why: def.why,
      successLooksLike: def.successLooksLike,
      deadline: def.deadline,
      createdAt,
      items,
    }
  );
  if (created.length < 0) return null; // unreachable; query has no RETURN
  return getGoal(userId, goalId);
}

export interface GoalDetailsInput {
  title?: string;
  why?: string;
  successLooksLike?: string;
  deadline?: string;
}

/** Cap a title at 6 words / 80 chars (same rule as milestones). */
function capTitle(s: string): string {
  return s.split(/\s+/).slice(0, 6).join(' ').slice(0, 80);
}

/**
 * Set only the given non-empty details on the user's goal (title max 6 words / 80 chars,
 * why and successLooksLike max 200 chars, deadline max 60 chars). Returns the fresh Goal,
 * or null when the goal does not belong to this user.
 */
export async function updateGoalDetails(
  userId: string,
  goalId: string,
  details: GoalDetailsInput
): Promise<Goal | null> {
  const title =
    typeof details.title === 'string' && details.title.trim() ? capTitle(details.title.trim()) : null;
  const why =
    typeof details.why === 'string' && details.why.trim() ? details.why.trim().slice(0, 200) : null;
  const successLooksLike =
    typeof details.successLooksLike === 'string' && details.successLooksLike.trim()
      ? details.successLooksLike.trim().slice(0, 200)
      : null;
  const deadline =
    typeof details.deadline === 'string' && details.deadline.trim()
      ? details.deadline.trim().slice(0, 60)
      : null;
  if (!title && !why && !successLooksLike && !deadline) return getGoal(userId, goalId);
  const rows = await run(
    `MATCH (:NSUser {id: $userId})-[:PURSUES]->(g: NSGoal {id: $goalId})
     SET g.title = coalesce($title, g.title)
     SET g.why = coalesce($why, g.why)
     SET g.successLooksLike = coalesce($successLooksLike, g.successLooksLike)
     SET g.deadline = coalesce($deadline, g.deadline)
     RETURN g.id AS goalId`,
    { userId, goalId, title, why, successLooksLike, deadline }
  );
  if (rows.length === 0) return null; // not their goal
  return getGoal(userId, goalId);
}

// ---------------------------------------------------------------------------
// Goal details (small facts recorded by the coach)
// ---------------------------------------------------------------------------

/**
 * Record one small fact about the user's goal: text is trimmed and capped at 120 chars,
 * exact duplicates (case-insensitive, per goal) are skipped, and a goal holds at most
 * 30 details. Returns the fresh detail, or null when nothing was stored.
 */
export async function addDetail(
  userId: string,
  goalId: string,
  kind: DetailKind,
  text: string
): Promise<GoalDetail | null> {
  if (!(DETAIL_KINDS as readonly string[]).includes(kind)) return null;
  const trimmed = text.trim().slice(0, 120);
  if (!trimmed) return null;
  const rows = await run(
    `MATCH (:NSUser {id: $userId})-[:PURSUES]->(g: NSGoal {id: $goalId})
     OPTIONAL MATCH (g)-[:HAS_DETAIL]->(existing: NSDetail)
     WITH g, collect(existing) AS existingDetails
     WHERE size(existingDetails) < 30
       AND none(d IN existingDetails WHERE toLower(d.text) = toLower($text))
     CREATE (d: NSDetail {id: $id, kind: $kind, text: $text, createdAt: $createdAt})
     CREATE (g)-[:HAS_DETAIL]->(d)
     RETURN d {.*} AS detail`,
    { userId, goalId, kind, text: trimmed, id: newId(), createdAt: nowIso() }
  );
  if (rows.length === 0) return null;
  return mapDetail(rows[0].detail as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/** Toggle a milestone; returns the updated parent goal, or null if not found for this user. */
export async function toggleMilestone(userId: string, milestoneId: string): Promise<Goal | null> {
  const rows = await run(
    `MATCH (u: NSUser {id: $userId})-[:PURSUES]->(g: NSGoal)-[:HAS_MILESTONE]->(m: NSMilestone {id: $milestoneId})
     SET m.done = NOT m.done
     SET m.doneAt = CASE WHEN m.done = true THEN $now ELSE null END
     RETURN g.id AS goalId`,
    { userId, milestoneId, now: nowIso() }
  );
  if (rows.length === 0) return null;
  return getGoal(userId, String(rows[0].goalId));
}

/** Mark a milestone of this goal done. Returns true only if it transitioned. */
export async function completeMilestone(goalId: string, milestoneId: string): Promise<boolean> {
  const rows = await run(
    `MATCH (g: NSGoal {id: $goalId})-[:HAS_MILESTONE]->(m: NSMilestone {id: $milestoneId})
     WHERE m.done = false
     SET m.done = true, m.doneAt = $now
     RETURN m.id AS id`,
    { goalId, milestoneId, now: nowIso() }
  );
  return rows.length > 0;
}

/** Append a milestone to a goal (linked into the NEXT chain). Returns the new Milestone. */
export async function addMilestone(goalId: string, title: string): Promise<Milestone | null> {
  const id = newId();
  const rows = await run(
    `MATCH (g: NSGoal {id: $goalId})
     OPTIONAL MATCH (g)-[:HAS_MILESTONE]->(existing: NSMilestone)
     WITH g, coalesce(max(existing.\`order\`), -1) + 1 AS newOrder
     CREATE (nm: NSMilestone {id: $id, title: $title, done: false, \`order\`: newOrder, doneAt: null})
     CREATE (g)-[:HAS_MILESTONE]->(nm)
     RETURN newOrder`,
    { goalId, id, title }
  );
  if (rows.length === 0) return null;
  const order = toNum(rows[0].newOrder);
  // link the previous last milestone to the new one, when one exists
  await run(
    `MATCH (prev: NSMilestone)<-[:HAS_MILESTONE]-(:NSGoal {id: $goalId})
     WHERE prev.\`order\` = $prevOrder
     MATCH (next: NSMilestone {id: $id})
     CREATE (prev)-[:NEXT]->(next)`,
    { goalId, id, prevOrder: order - 1 }
  );
  return { id, title, done: false, order, brightness: milestoneBrightness(false) };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityInput {
  userId: string;
  goalId: string;
  onTask: boolean;
  minutes: number;
  source: string;
}

export async function logActivity(input: ActivityInput): Promise<void> {
  await run(
    `MATCH (u: NSUser {id: $userId}), (g: NSGoal {id: $goalId})
     CREATE (a: NSActivity {id: $id, minutes: $minutes, onTask: $onTask, source: $source, at: $at})
     CREATE (u)-[:LOGGED]->(a)
     CREATE (a)-[:FOR]->(g)`,
    { ...input, id: newId(), at: nowIso() }
  );
}

// ---------------------------------------------------------------------------
// Stats (all computed on read)
// ---------------------------------------------------------------------------

/** score = focusedMinutes + 100 * milestonesDone + 25 * streak; starsLit = goals + done milestones. */
export async function computeStats(userId: string): Promise<Stats> {
  const empty: Stats = { score: 0, streak: 0, focusedMinutes: 0, milestonesDone: 0, starsLit: 0 };
  const rows = await run(
    `MATCH (u: NSUser {id: $userId})
     CALL {
       WITH u
       OPTIONAL MATCH (u)-[:LOGGED]->(a: NSActivity)
       WHERE a.onTask = true
       RETURN coalesce(sum(a.minutes), 0) AS focusedMinutes, collect(a.at) AS actTimes
     }
     CALL {
       WITH u
       OPTIONAL MATCH (u)-[:PURSUES]->(g: NSGoal)
       RETURN count(DISTINCT g.id) AS goalCount
     }
     CALL {
       WITH u
       OPTIONAL MATCH (u)-[:PURSUES]->(:NSGoal)-[:HAS_MILESTONE]->(m: NSMilestone)
       WHERE m.done = true
       RETURN count(m) AS doneCount, collect(m.doneAt) AS doneTimes
     }
     RETURN focusedMinutes, actTimes, goalCount, doneCount, doneTimes`,
    { userId }
  );
  if (rows.length === 0) return empty;
  const row = rows[0];
  const focusedMinutes = toNum(row.focusedMinutes);
  const goalCount = toNum(row.goalCount);
  const milestonesDone = toNum(row.doneCount);
  const times = [
    ...((row.actTimes as unknown[]) ?? []),
    ...((row.doneTimes as unknown[]) ?? []),
  ].filter((t): t is string => typeof t === 'string');
  const streak = computeStreak(times);
  return {
    score: focusedMinutes + 100 * milestonesDone + 25 * streak,
    streak,
    focusedMinutes,
    milestonesDone,
    starsLit: goalCount + milestonesDone,
  };
}

// ---------------------------------------------------------------------------
// Cleanup (seed + acceptance test)
// ---------------------------------------------------------------------------

/** Delete a non-seeded user and everything hanging off them (goals, milestones, activities). */
export async function deleteNonSeededUsersByName(name: string): Promise<number> {
  const found = await run(
    `MATCH (u: NSUser {nameLower: $nameLower})
     WHERE u.seeded = false
     RETURN collect(u.id) AS ids`,
    { nameLower: name.toLowerCase() }
  );
  const ids = (found[0]?.ids as string[]) ?? [];
  if (ids.length === 0) return 0;
  await deleteUserCascade(ids);
  return ids.length;
}

export async function deleteUserCascade(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await run(
    `UNWIND $userIds AS uid
     MATCH (u: NSUser {id: uid})-[:LOGGED]->(a: NSActivity)
     DETACH DELETE a`,
    { userIds }
  );
  await run(
    `UNWIND $userIds AS uid
     MATCH (:NSUser {id: uid})-[:PURSUES]->(g: NSGoal)-[:HAS_DETAIL]->(d: NSDetail)
     DETACH DELETE d`,
    { userIds }
  );
  await run(
    `UNWIND $userIds AS uid
     MATCH (:NSUser {id: uid})-[:PURSUES]->(g: NSGoal)-[:HAS_MILESTONE]->(m: NSMilestone)
     DETACH DELETE m`,
    { userIds }
  );
  await run(
    `UNWIND $userIds AS uid
     MATCH (:NSUser {id: uid})-[:PURSUES]->(g: NSGoal)
     DETACH DELETE g`,
    { userIds }
  );
  await run(
    `UNWIND $userIds AS uid
     MATCH (u: NSUser {id: uid})
     DETACH DELETE u`,
    { userIds }
  );
}
