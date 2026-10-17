import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { sound } from './sound'
import type { ChatMessage, FocusState, Goal, PointsRow, Stats, User } from './types'
import { Universe, type View } from './scene/Universe'
import { ChatDock } from './ui/ChatDock'
import { GoalPanel, Leaderboard, Onboarding, StarRail, TopBar } from './ui/Panels'
import { FocusCard } from './ui/FocusCard'

const desktop = typeof window !== 'undefined' ? window.northStarDesktop : undefined

const EMPTY_STATS: Stats = { score: 0, streak: 0, focusedMinutes: 0, milestonesDone: 0, starsLit: 0 }
const NEW = '__new__'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const byCreated = (goals: Goal[]) => [...goals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
const nowSec = () => performance.now() / 1000

type Toast = { id: number; text: string }

export default function App() {
  const [user, setUser] = useState<User | null>(() => read<User | null>('ns.user', null))
  const [goals, setGoals] = useState<Goal[]>([])
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [forgeIndex, setForgeIndex] = useState(0)
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({})
  const [understanding, setUnderstanding] = useState(0)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('sky')
  const [leaders, setLeaders] = useState<PointsRow[]>([])
  const [pointsOffline, setPointsOffline] = useState(false)
  const [myPoints, setMyPoints] = useState<PointsRow | null>(null)
  const [focus, setFocus] = useState<FocusState | null>(null)
  const [useCamera, setUseCamera] = useState(() => read('ns.camera', false))
  const [bornAt, setBornAt] = useState<Record<string, number>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({})
  const busyRef = useRef(false)

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3600)
  }, [])

  const applyGoals = useCallback((next: Goal[]) => setGoals(byCreated(next)), [])

  // Load the signed-in user's sky, and their saved conversations.
  useEffect(() => {
    if (!user) return
    setThreads(read(`ns.threads.${user.id}`, {}))
    setUnderstanding(read(`ns.understanding.${user.id}`, 0))
    api.getUser(user.id)
      .then(res => {
        const sorted = byCreated(res.goals)
        setGoals(sorted)
        setStats(res.stats)
        setUser(res.user)
        if (res.points !== undefined) setMyPoints(res.points)
        if (sorted.length) setSelected(sorted[sorted.length - 1].id)
        setForgeIndex(sorted.length)
      })
      .catch(err => {
        if (String(err).includes('404') || String(err).toLowerCase().includes('not found')) {
          localStorage.removeItem('ns.user')
          setUser(null)
        } else {
          toast('Could not reach the server.')
        }
      })
      .finally(() => setLoaded(true))
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (user) write(`ns.threads.${user.id}`, threads) }, [threads, user])
  useEffect(() => { if (user) write(`ns.understanding.${user.id}`, understanding) }, [understanding, user])

  useEffect(() => { write('ns.camera', useCamera) }, [useCamera])

  // Everyone's points, from the shared points service. Refreshed often in cosmos view, slowly otherwise.
  const refreshCosmos = useCallback(() => {
    api.leaderboard()
      .then(r => { setLeaders(r.rows); setPointsOffline(r.offline) })
      .catch(() => setPointsOffline(true))
  }, [])
  useEffect(() => {
    refreshCosmos()
    const id = setInterval(refreshCosmos, view === 'cosmos' ? 6000 : 20000)
    return () => clearInterval(id)
  }, [view, refreshCosmos])

  // Keep the sky in sync with progress made elsewhere (other tabs, the coach, the points service).
  useEffect(() => {
    if (!user) return
    const id = setInterval(() => {
      if (busyRef.current) return
      api.getUser(user.id).then(res => {
        applyGoals(res.goals)
        setStats(res.stats)
        if (res.points !== undefined) setMyPoints(res.points)
      }).catch(() => {})
    }, 10000)
    return () => clearInterval(id)
  }, [user, applyGoals])

  // Desktop shell: verified focus checks arrive as state pushes from the Electron main process.
  const lastCheckAt = useRef<string | null>(null)
  useEffect(() => {
    if (!desktop) return
    void desktop.focus.getState().then(setFocus).catch(() => {})
    return desktop.focus.onState(state => {
      setFocus(state)
      const check = state.lastCheck
      if (!check || check.at === lastCheckAt.current) return
      lastCheckAt.current = check.at
      const result = state.lastResult
      if (result) {
        setGoals(gs => byCreated(gs.map(g => (g.id === result.goal.id ? result.goal : g))))
        setStats(result.stats)
        if (result.points) setMyPoints(result.points)
      }
      if (check.counted) sound.twinkle(Math.floor(Math.random() * 5), false)
      else if (check.verdict === 'off_track' && (check.roast || check.nudge)) toast(check.roast || check.nudge)
    })
  }, [toast])

  // Tell the shared cosmos which goal this player is working on.
  useEffect(() => {
    if (!user || !selected) return
    const id = setTimeout(() => {
      api.setActiveGoal(user.id, selected).then(r => { if (r.points) setMyPoints(r.points) }).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [user?.id, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const discovering = loaded && selected === null
  const selectedGoal = goals.find(g => g.id === selected) ?? null
  const threadKey = selected ?? NEW
  const messages = threads[threadKey] ?? []
  const focusIndex = discovering ? forgeIndex : Math.max(0, goals.findIndex(g => g.id === selected))
  const meId = user?.pointsPlayerId ?? myPoints?.id ?? null
  const myRow = leaders.find(r => r.id === meId) ?? myPoints
  const others = useMemo(
    () => leaders.filter(r => r.id !== meId && r.name.toLowerCase() !== user?.name.toLowerCase()),
    [leaders, meId, user?.name],
  )
  const focusingGoal = focus && focus.status === 'active' ? focus.goalId : null

  const setThread = (key: string, msgs: ChatMessage[]) => setThreads(t => ({ ...t, [key]: msgs }))

  const send = async (text: string) => {
    if (!user) return
    sound.unlock()
    const key = threadKey
    const goalId = selected ?? undefined
    const msgs: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setThread(key, msgs)
    setSuggestions(s => ({ ...s, [key]: [] }))
    setBusy(true)
    busyRef.current = true
    try {
      const res = await api.chat(user.id, msgs, goalId)
      const withReply: ChatMessage[] = [...msgs, { role: 'assistant', content: res.reply }]
      applyGoals(res.goals)
      setStats(res.stats)

      const created = res.events.find(e => e.type === 'goal_created')
      if (created && created.type === 'goal_created') {
        const birth = nowSec() + 0.2
        setBornAt(b => ({ ...b, [created.goal.id]: birth }))
        setUnderstanding(1)
        setThreads(t => ({ ...t, [created.goal.id]: withReply, [NEW]: [] }))
        setSuggestions(s => ({ ...s, [created.goal.id]: res.suggestions ?? [], [NEW]: [] }))
        setSelected(created.goal.id)
        setTimeout(() => sound.birth(), 200)
        created.goal.milestones.forEach((_, i) => setTimeout(() => sound.twinkle(i), 200 + (1.5 + i * 0.55) * 1000))
        setTimeout(() => setUnderstanding(0), 4000)
        setTimeout(refreshCosmos, 1500)
      } else {
        setThread(key, withReply)
        setSuggestions(s => ({ ...s, [key]: res.suggestions ?? [] }))
        if (!goalId) setUnderstanding(u => Math.max(u, res.understanding))
        sound.tick()
      }

      res.events.forEach((e, i) => {
        if (e.type === 'milestone_done') {
          const m = res.goals.find(g => g.id === e.goalId)?.milestones.find(x => x.id === e.milestoneId)
          setTimeout(() => sound.twinkle(m?.order ?? i, true), 150 * i)
          toast(`Star lit: ${m?.title ?? 'milestone'}`)
        } else if (e.type === 'milestone_added') {
          sound.twinkle(e.milestone.order)
          toast(`New star added: ${e.milestone.title}`)
        } else if (e.type === 'focus_logged') {
          toast(`+${e.minutes} min of focus logged`)
        } else if (e.type === 'details_updated') {
          sound.twinkle(2 + i)
        } else if (e.type === 'detail_added') {
          setTimeout(() => sound.twinkle(4 + i), 120 * i)
        } else if (e.type === 'goal_ready') {
          setTimeout(() => sound.birth(), 300)
          toast('Your star is ready. Begin a focus session whenever you are.')
        }
      })
    } catch {
      toast('The stars went quiet. Check the server and try again.')
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  const toggleMilestone = async (milestoneId: string) => {
    if (!user) return
    sound.unlock()
    try {
      const res = await api.toggleMilestone(user.id, milestoneId)
      setGoals(gs => byCreated(gs.map(g => (g.id === res.goal.id ? res.goal : g))))
      setStats(res.stats)
      const m = res.goal.milestones.find(x => x.id === milestoneId)
      if (m?.done) sound.twinkle(m.order, true)
    } catch {
      toast('Could not update that milestone.')
    }
  }

  const focusControls = (goal: Goal) => (
    <FocusCard
      focus={focus}
      goalId={goal.id}
      desktop={!!desktop}
      camera={focus?.status && focus.status !== 'idle' ? focus.cameraEnabled : useCamera}
      onCamera={enabled => {
        setUseCamera(enabled)
        if (focus && focus.status !== 'idle') void desktop?.focus.setCamera(enabled).then(setFocus)
      }}
      onStart={() => {
        if (!user || !desktop) return
        sound.unlock()
        void desktop.focus.start({ userId: user.id, goalId: goal.id, goalTitle: goal.title, camera: useCamera })
          .then(setFocus)
          .catch(() => toast('Could not start focus checks.'))
      }}
      onPause={() => void desktop?.focus.pause().then(setFocus)}
      onResume={() => void desktop?.focus.resume().then(setFocus)}
      onStop={() => void desktop?.focus.stop().then(setFocus)}
    />
  )

  const startNewStar = () => {
    setSelected(null)
    setForgeIndex(goals.length)
    setUnderstanding(0)
    setView('sky')
  }

  const createUser = async (name: string) => {
    const res = await api.createUser(name)
    write('ns.user', res.user)
    setLoaded(false)
    setUser(res.user)
  }

  const color = user?.color ?? '#cfe2ff'

  return (
    <div className={`app view-${view} ${selectedGoal && !discovering ? 'has-panel' : ''} ${desktop ? 'is-desktop' : ''}`} style={{ ['--me' as string]: color }}>
      <Universe
        me={user}
        myGoals={goals}
        bornAt={bornAt}
        focusIndex={focusIndex}
        discovering={discovering}
        understanding={understanding}
        view={view}
        others={others}
        myScore={myRow?.points ?? stats.score}
        focusing={focusingGoal}
      />

      <TopBar user={user} stats={stats} points={myRow ?? null} view={view} onView={v => { sound.unlock(); setView(v) }} />

      {user && view === 'sky' && (
        <div className="left-column">
          <StarRail goals={goals} selected={selected} discovering={discovering} color={color}
            onSelect={id => setSelected(id)} onNew={startNewStar} />
          {selectedGoal && !discovering && (
            <GoalPanel key={selectedGoal.id} goal={selectedGoal} color={color} onToggle={toggleMilestone} focus={focusControls(selectedGoal)}
              onAsk={text => { if (!busy) void send(text) }} />
          )}
        </div>
      )}

      {user && view === 'cosmos' && (
        <>
          <Leaderboard rows={leaders} meId={meId} offline={pointsOffline} />
          <p className="cosmos-caption">Every constellation is someone’s goal. It grows brighter with every verified minute they work on it.</p>
        </>
      )}

      {user && loaded && view === 'sky' && (
        <ChatDock
          messages={messages}
          busy={busy}
          discovering={discovering}
          understanding={understanding}
          hasGoals={goals.length > 0}
          goalTitle={selectedGoal?.title}
          onSend={send}
          onError={toast}
          suggestions={suggestions[threadKey] ?? []}
          little={selectedGoal?.status === 'brainstorm'}
        />
      )}

      {!user && <Onboarding onSubmit={createUser} />}

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className="toast glass">{t.text}</div>)}
      </div>
    </div>
  )
}
