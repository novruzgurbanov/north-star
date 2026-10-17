export type Milestone = { id: string; title: string; done: boolean; order: number; brightness: number }

export type DetailKind = 'subgoal' | 'action' | 'motivation' | 'obstacle' | 'distraction' | 'on_track'

export type GoalDetail = { id: string; kind: DetailKind; text: string; createdAt: string }

export type Session = {
  id: string; task: string; plannedMinutes: number; activeSeconds: number
  verifiedSeconds: number; drifts: number; headline: string; endedAt: string
}

export type NextStep = { task: string; minutes: number; why: string; milestoneId: string | null }

export type Recap = {
  session: Session; headline: string; summary: string; driftNote: string
  next: { task: string; minutes: number }; suggestMilestoneId: string | null
}

/* ---------- v2: AI-built goal panels (see PANELS.md) ---------- */

export type Profile = 'screen' | 'offline' | 'habit' | 'quantity' | 'project' | 'mixed'

export type FieldKind = 'number' | 'minutes' | 'text' | 'rating' | 'boolean'
export type Field = { key: string; label: string; kind: FieldKind; unit?: string; required?: boolean }

export type ChecklistItem = { id: string; text: string; done: boolean }

/** One built-in widget, configured by the AI. The spec only selects widgets; it never runs code. */
export type Widget = { id: string; title: string } & (
  | { type: 'milestones' }
  | { type: 'focus_session'; minutes: number[] }
  | { type: 'next_step' }
  | { type: 'log'; fields: Field[]; proof: 'none' | 'optional' | 'required'; proofHint: string }
  | { type: 'streak'; source: string; cadence: 'daily' | 'weekly'; perPeriod: number }
  | { type: 'counter'; source: string; field: string; unit: string; target: number; period: 'week' | 'month' | 'total' }
  | { type: 'chart'; source: string; field: string; unit: string; period: 'week' | 'month'; span: number }
  | { type: 'habit_grid'; source: string; days: 14 | 28 }
  | { type: 'checklist'; items: ChecklistItem[] }
  | { type: 'countdown'; date: string; label: string }
  | { type: 'note'; text: string }
)
export type WidgetType = Widget['type']
export type WidgetOf<T extends WidgetType> = Extract<Widget, { type: T }>

export type PanelSpec = {
  version: number
  profile: Profile
  summary: string
  widgets: Widget[]
  updatedAt: string
}

export type ProofVerdict = 'none' | 'verified' | 'unverified' | 'rejected'
export type EntryValues = Record<string, number | string | boolean>

/** Something the user logged in a `log` widget. `proof: 'none'` means self-reported. */
export type Entry = {
  id: string; widgetId: string; at: string; values: EntryValues; note: string
  minutes: number; proof: ProofVerdict; proofReason: string
}

/** Manual panel edits that don't need the AI. `move.to` is the widget's new index. */
export type WidgetOp = { kind: 'remove' } | { kind: 'move'; to: number } | { kind: 'toggle_item'; itemId: string }

export type Goal = {
  id: string
  title: string
  why: string
  successLooksLike: string
  deadline: string | null
  brightness: number
  createdAt: string
  milestones: Milestone[]
  /** brainstorm = a little star with few details; ready = has success + at least one step */
  status?: 'brainstorm' | 'ready'
  missing?: Array<'success' | 'steps' | 'why'>
  details?: GoalDetail[]
  sessions?: Session[]
  public?: boolean
  /** v2: the AI-designed panel; null until the web UI asks for one on a ready goal */
  panel?: PanelSpec | null
  /** v2: logged entries, newest first (max 400, last 400 days) */
  entries?: Entry[]
}

export type User = { id: string; name: string; color: string; seeded: boolean; pointsPlayerId?: string | null }

export type Stats = {
  score: number
  streak: number
  focusedMinutes: number
  milestonesDone: number
  starsLit: number
}

export type Settings = {
  helpfulness: 'quiet' | 'balanced' | 'proactive'
  checkSeconds: number
  strictness: 'relaxed' | 'normal' | 'strict'
  roast: 'off' | 'mild' | 'spicy'
  notifications: boolean
  cameraByDefault: boolean
  suggestions: boolean
  sounds: boolean
  shareGoalTitle: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  helpfulness: 'balanced', checkSeconds: 20, strictness: 'normal', roast: 'mild',
  notifications: true, cameraByDefault: false, suggestions: true, sounds: true, shareGoalTitle: true,
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type AgentEvent =
  | { type: 'goal_created'; goal: Goal }
  | { type: 'milestone_done'; goalId: string; milestoneId: string }
  | { type: 'milestone_added'; goalId: string; milestone: Milestone }
  | { type: 'focus_logged'; goalId: string; minutes: number }
  | { type: 'details_updated'; goalId: string; goal: Goal }
  | { type: 'goal_ready'; goalId: string }
  | { type: 'detail_added'; goalId: string; detail: GoalDetail }
  | { type: 'entry_logged'; goalId: string; entry: Entry }
  | { type: 'panel_updated'; goalId: string; goal: Goal; change: string }

export type ChatResponse = {
  reply: string
  understanding: number
  phase: 'discovering' | 'coaching'
  events: AgentEvent[]
  goals: Goal[]
  stats: Stats
  suggestions?: string[]
}

/** A goal a player chose to make public (see POINTS.md). */
export type PublicGoal = {
  id: string; title: string; status: 'brainstorm' | 'ready'; brightness: number
  milestonesDone: number; milestonesTotal: number
}

/** A player in the shared points service (see POINTS.md). */
export type PointsRow = {
  id: string
  name: string
  color: string
  goalTitle: string | null
  createdAt: string
  rank: number
  points: number
  focusedMinutes: number
  todayMinutes: number
  streak: number
  lastActiveAt: string | null
  live: boolean
  sources: string[]
  goals?: PublicGoal[]
}

export type FocusStatus = 'idle' | 'active' | 'paused' | 'error'

export type FocusCheck = {
  at: string
  verdict: 'on_track' | 'off_track' | 'uncertain'
  confidence: number
  reason: string
  nudge: string
  roast?: string
  counted: boolean
  countedSeconds: number
}

export type FocusState = {
  status: FocusStatus
  userId: string | null
  goalId: string | null
  goalTitle: string | null
  startedAt: string | null
  nextCheckAt: string | null
  checkSeconds: number
  sessionVerifiedSeconds: number
  checks: number
  cameraEnabled: boolean
  cameraActive: boolean
  lastCheck: FocusCheck | null
  lastResult: { goal: Goal; stats: Stats; points: PointsRow | null } | null
  error: string | null
  notice?: string | null
  task?: string | null
  plannedMinutes?: number | null
  activeSeconds: number
  activeSince: string | null
  history?: Array<Pick<FocusCheck, 'at' | 'verdict' | 'confidence' | 'reason' | 'counted' | 'countedSeconds'>>
  lastSession?: {
    goalId: string; goalTitle: string; task: string | null; plannedMinutes: number | null
    activeSeconds: number; verifiedSeconds: number; completed: boolean; endedAt: string
    history: Array<Pick<FocusCheck, 'at' | 'verdict' | 'reason'>>
  } | null
}

export interface NorthStarDesktop {
  isDesktop: true
  platform: string
  focus: {
    start(opts: { userId: string; goalId: string; goalTitle: string; camera: boolean; task?: string; plannedMinutes?: number }): Promise<FocusState>
    pause(): Promise<FocusState>
    resume(): Promise<FocusState>
    stop(): Promise<FocusState>
    setCamera(enabled: boolean): Promise<FocusState>
    configure?(opts: { checkSeconds?: number; notifications?: boolean }): Promise<FocusState>
    getState(): Promise<FocusState>
    onState(listener: (state: FocusState) => void): () => void
  }
}

declare global {
  interface Window { northStarDesktop?: NorthStarDesktop }
}
