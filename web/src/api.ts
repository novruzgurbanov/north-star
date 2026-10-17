import type { ChatMessage, ChatResponse, Entry, EntryValues, Goal, NextStep, PointsRow, Recap, Settings, Stats, User, WidgetOp } from './types'

/** An API failure that keeps the HTTP status and the server's error code, so callers can tell the undo route's two 409s apart. */
export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}

async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    // The server answers errors as { error, code? }; keep both, or the raw text if it isn't JSON.
    const text = await res.text().catch(() => '')
    let message = text
    let code: string | undefined
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string }
      message = parsed.error || text
      code = parsed.code
    } catch { /* not JSON */ }
    throw new ApiError(message || `${res.status} ${res.statusText}`, res.status, code)
  }
  return res.json() as Promise<T>
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  setColor: (userId: string, color: string) => patch<{ user: User }>(`/users/${userId}`, { color }),
  deleteGoal: async (userId: string, goalId: string) => {
    const res = await fetch(`/api/goals/${goalId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status}`)
    return res.json() as Promise<{ goals: Goal[]; stats: Stats }>
  },
  setGoalPublic: (userId: string, goalId: string, isPublic: boolean) => patch<{ goal: Goal }>(`/goals/${goalId}`, { userId, public: isPublic }),
  createUser: (name: string) => call<{ user: User }>('/users', { name }),
  getUser: (userId: string) =>
    call<{ user: User; goals: Goal[]; stats: Stats; points?: PointsRow | null; settings?: Settings }>(`/users/${userId}`),
  saveSettings: async (userId: string, patch: Partial<Settings>) => {
    const res = await fetch(`/api/users/${userId}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<{ settings: Settings }>
  },
  setActiveGoal: (userId: string, goalId: string) =>
    call<{ ok: boolean; points: PointsRow | null }>(`/users/${userId}/active-goal`, { goalId }),
  chat: (userId: string, messages: ChatMessage[], goalId?: string) =>
    call<ChatResponse>('/chat', { userId, goalId, messages }),
  toggleMilestone: (userId: string, milestoneId: string) =>
    call<{ goal: Goal; stats: Stats }>(`/milestones/${milestoneId}/toggle`, { userId }),
  activity: (userId: string, goalId: string, minutes: number) =>
    call<{ goal: Goal; stats: Stats }>('/activity', { userId, goalId, onTask: true, minutes, source: 'web' }),
  transcribe: async (pcm: Float32Array) => {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm.slice().buffer,
    })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status}`)
    return res.json() as Promise<{ text: string; ms: number; seconds: number }>
  },
  nextStep: (userId: string, goalId: string) => call<NextStep>(`/goals/${goalId}/next-step`, { userId }),
  recap: (body: {
    userId: string; goalId: string; task: string; plannedMinutes: number; activeSeconds: number
    verifiedSeconds: number; completed: boolean; checks: { at: string; verdict: string; reason: string }[]
  }) => call<Recap>('/sessions/recap', body),
  leaderboard: (mode: 'real' | 'demo' = 'real') => call<{ rows: PointsRow[]; offline: boolean }>(`/leaderboard?mode=${mode}`),

  // v2: AI-built goal panels (PANELS.md section 2)
  designPanel: (userId: string, goalId: string, instruction?: string) =>
    send<{ goal: Goal }>('POST', `/goals/${goalId}/panel/design`, instruction ? { userId, instruction } : { userId }),
  editPanel: (userId: string, goalId: string, instruction: string) =>
    send<{ goal: Goal; change: string }>('POST', `/goals/${goalId}/panel/edit`, { userId, instruction }),
  undoPanel: (userId: string, goalId: string) => send<{ goal: Goal }>('POST', `/goals/${goalId}/panel/undo`, { userId }),
  widgetOp: (userId: string, goalId: string, widgetId: string, op: WidgetOp) =>
    send<{ goal: Goal }>('PATCH', `/goals/${goalId}/panel/widgets/${widgetId}`, { userId, op }),
  /** `proof` is a base64 JPEG without the data-URL prefix (same as focus checks). */
  createEntry: (userId: string, goalId: string, body: { widgetId: string; values: EntryValues; note?: string; proof?: string }) =>
    send<{ entry: Entry; goal: Goal; stats: Stats; points: PointsRow | null }>('POST', `/goals/${goalId}/entries`, { userId, ...body }),
  deleteEntry: (userId: string, goalId: string, entryId: string) =>
    send<{ goal: Goal; stats: Stats }>('DELETE', `/goals/${goalId}/entries/${entryId}`, { userId }),
}
