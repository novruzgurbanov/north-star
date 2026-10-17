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

// ---------------------------------------------------------------------------
// AI-built goal panels (../PANELS.md). The AI writes a declarative spec; the
// server sanitizes it (src/panel.ts) and the web UI renders built-in widgets.
// ---------------------------------------------------------------------------

export type PanelProfile = 'screen' | 'offline' | 'habit' | 'quantity' | 'project' | 'mixed';

export const PANEL_PROFILES: readonly PanelProfile[] = ['screen', 'offline', 'habit', 'quantity', 'project', 'mixed'];

export type FieldKind = 'number' | 'minutes' | 'text' | 'rating' | 'boolean';

/** One input of a log widget. key is snake_case (1-24), label <= 24, unit <= 10. */
export type Field = { key: string; label: string; kind: FieldKind; unit?: string; required?: boolean };

export type ProofMode = 'none' | 'optional' | 'required';

export type ChecklistItem = { id: string; text: string; done: boolean }; // id "i_" + 4-12 [a-z0-9], text <= 60

type WidgetBase = { id: string; title: string }; // id "w_" + 4-12 [a-z0-9] (server-assigned), title 1-40

export type MilestonesWidget = WidgetBase & { type: 'milestones' };
export type FocusSessionWidget = WidgetBase & { type: 'focus_session'; minutes: number[] }; // 1-4 values, 5..180
export type NextStepWidget = WidgetBase & { type: 'next_step' };
export type LogWidget = WidgetBase & { type: 'log'; fields: Field[]; proof: ProofMode; proofHint: string }; // 1-5 fields, hint <= 80
export type StreakWidget = WidgetBase & { type: 'streak'; source: string; cadence: 'daily' | 'weekly'; perPeriod: number }; // 1..14
export type CounterWidget = WidgetBase & {
  type: 'counter';
  source: string;
  field: string;
  unit: string;
  target: number; // > 0
  period: 'week' | 'month' | 'total';
};
export type ChartWidget = WidgetBase & {
  type: 'chart';
  source: string;
  field: string;
  unit: string;
  period: 'week' | 'month';
  span: number; // 4..12
};
export type HabitGridWidget = WidgetBase & { type: 'habit_grid'; source: string; days: 14 | 28 };
export type ChecklistWidget = WidgetBase & { type: 'checklist'; items: ChecklistItem[] }; // 1-10 items
export type CountdownWidget = WidgetBase & { type: 'countdown'; date: string; label: string }; // YYYY-MM-DD, label <= 40
export type NoteWidget = WidgetBase & { type: 'note'; text: string }; // <= 400, plain text

export type Widget =
  | MilestonesWidget
  | FocusSessionWidget
  | NextStepWidget
  | LogWidget
  | StreakWidget
  | CounterWidget
  | ChartWidget
  | HabitGridWidget
  | ChecklistWidget
  | CountdownWidget
  | NoteWidget;

export type WidgetType = Widget['type'];

export type PanelSpec = {
  version: number; // increments on every change
  profile: PanelProfile; // how this goal is mostly worked on
  summary: string; // <= 140 chars, second person
  widgets: Widget[]; // ordered top to bottom, 1..8
  updatedAt: string; // ISO
};

export type ProofVerdict = 'none' | 'verified' | 'unverified' | 'rejected';

/** One thing the user logged in a log widget: (:NSGoal)-[:HAS_ENTRY]->(:NSEntry). */
export type Entry = {
  id: string;
  widgetId: string;
  at: string; // ISO
  values: Record<string, number | string | boolean>;
  note: string;
  minutes: number; // the first minutes-kind field value (0 if none), capped at 600
  proof: ProofVerdict;
  proofReason: string;
};

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
  panel: PanelSpec | null; // the AI-built panel (../PANELS.md); null until designed
  entries: Entry[]; // newest first, max 400, last 400 days
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
  | { type: 'goal_ready'; goalId: string }
  | { type: 'entry_logged'; goalId: string; entry: Entry }
  | { type: 'panel_updated'; goalId: string; goal: Goal; change: string };

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
