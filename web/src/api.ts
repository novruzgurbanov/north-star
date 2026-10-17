import type { ChatMessage, ChatResponse, Goal, PointsRow, Settings, Stats, User } from './types'

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

export const api = {
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
  leaderboard: (mode: 'real' | 'demo' = 'real') => call<{ rows: PointsRow[]; offline: boolean }>(`/leaderboard?mode=${mode}`),
}
