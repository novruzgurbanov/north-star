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

export type Goal = {
  id: string;
  title: string;
  why: string;
  successLooksLike: string;
  deadline: string | null;
  status: 'brainstorm' | 'ready'; // ready = successLooksLike non-empty AND milestones.length >= 1
  missing: Array<'success' | 'steps' | 'why'>; // the details still empty, in that order
  brightness: number; // 0..1; brainstorm stars 0.12 + 0.04 per filled detail, ready goals 0.25+
  createdAt: string; // ISO
  milestones: Milestone[]; // sorted by order
  details: GoalDetail[]; // small facts recorded by the coach, sorted by createdAt
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

// A goal candidate produced by the discover agent, before it is written to the graph.
export type NewGoal = {
  title: string;
  why: string;
  successLooksLike: string;
  deadline: string | null;
  milestones: string[];
};
