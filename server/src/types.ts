// API contract types (../CONTRACT.md)

export type Milestone = { id: string; title: string; done: boolean; order: number; brightness: number }; // 0..1

export type DetailKind = 'subgoal' | 'action' | 'motivation' | 'obstacle' | 'distraction' | 'on_track';

export const DETAIL_KINDS: readonly DetailKind[] = [
  'subgoal',
  'action',
  'motivation',
  'obstacle',
  'distraction',
  'on_track',
];

export type GoalDetail = { id: string; kind: DetailKind; text: string; createdAt: string };

export type Session = {
  id: string;
  task: string;
  plannedMinutes: number;
  activeSeconds: number;
  verifiedSeconds: number;
  drifts: number; // number of off_track checks in the session
  headline: string;
  endedAt: string; // ISO
};

/** One focus-check verdict as the desktop app reported it during a session. */
export type SessionCheck = { at: string; verdict: 'on_track' | 'off_track' | 'uncertain'; reason: string };

export type Goal = {
  id: string;
  title: string;
  why: string;
  successLooksLike: string;
  deadline: string | null;
  status: 'brainstorm' | 'ready'; // ready = successLooksLike non-empty AND milestones.length >= 1
  public: boolean; // public goals are published to the shared cosmos; missing stored value -> true
  missing: Array<'success' | 'steps' | 'why'>; // the details still empty, in that order
  brightness: number; // 0..1; brainstorm stars 0.12 + 0.04 per filled detail, ready goals 0.25+
  createdAt: string; // ISO
  milestones: Milestone[]; // sorted by order
  details: GoalDetail[]; // small facts recorded by the coach, sorted by createdAt
  sessions: Session[]; // the 5 most recent focus sessions, newest first
};

export type User = { id: string; name: string; color: string; seeded: boolean; pointsPlayerId: string | null };

export type Stats = {
  score: number;
  streak: number;
  focusedMinutes: number;
  milestonesDone: number;
  starsLit: number;
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AgentEvent =
  | { type: 'goal_created'; goal: Goal }
  | { type: 'milestone_done'; goalId: string; milestoneId: string }
  | { type: 'milestone_added'; goalId: string; milestone: Milestone }
  | { type: 'focus_logged'; goalId: string; minutes: number }
  | { type: 'details_updated'; goalId: string; goal: Goal }
  | { type: 'detail_added'; goalId: string; detail: GoalDetail }
  | { type: 'goal_ready'; goalId: string };

export type Phase = 'discovering' | 'coaching';

// Per-user settings (../SETTINGS.md), stored as a JSON string on NSUser.
export type Helpfulness = 'quiet' | 'balanced' | 'proactive';
export type Strictness = 'relaxed' | 'normal' | 'strict';
export type RoastLevel = 'off' | 'mild' | 'spicy';

export type Settings = {
  helpfulness: Helpfulness;
  checkSeconds: number; // 10..300, desktop focus loop
  strictness: Strictness;
  roast: RoastLevel; // always PG
  notifications: boolean; // desktop toasts
  cameraByDefault: boolean;
  suggestions: boolean; // reply chips
  sounds: boolean;
  shareGoalTitle: boolean; // goal title on the shared leaderboard
};

export const DEFAULT_SETTINGS: Settings = {
  helpfulness: 'balanced',
  checkSeconds: 20,
  strictness: 'normal',
  roast: 'mild',
  notifications: true,
  cameraByDefault: false,
  suggestions: true,
  sounds: true,
  shareGoalTitle: true,
};

/** Count on-track focus time when confidence >= this (per strictness). */
export const COUNT_CONFIDENCE: Record<Strictness, number> = { relaxed: 0.5, normal: 0.6, strict: 0.75 };

/** Desktop notifies on off-track when confidence >= this; returned as `notifyAbove`. */
export const NOTIFY_ABOVE: Record<Strictness, number> = { relaxed: 0.85, normal: 0.7, strict: 0.6 };

// A goal candidate produced by the discover agent, before it is written to the graph.
export type NewGoal = {
  title: string;
  why: string;
  successLooksLike: string;
  deadline: string | null;
  milestones: string[];
  /** New goals are public by default (settings.shareGoalTitle); omitted -> true. */
  public?: boolean;
};
