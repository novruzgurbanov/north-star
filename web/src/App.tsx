import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { sound } from './sound'
import { DEFAULT_SETTINGS, type ChatMessage, type FocusState, type Goal, type PointsRow, type Settings, type Stats, type User } from './types'
import { Universe } from './scene/Universe'
import { Sidebar, type View } from './ui/Sidebar'
import { SettingsView } from './ui/SettingsView'
import { ChatDock } from './ui/ChatDock'
import { GoalPanel, Leaderboard, Onboarding, TopBar } from './ui/Panels'
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
  const [cosmosMode, setCosmosMode] = useState<'real' | 'demo'>(() => read('ns.cosmosMode', 'real'))
  const [myPoints, setMyPoints] = useState<PointsRow | null>(null)
  const [focus, setFocus] = useState<FocusState | null>(null)
  const [useCamera, setUseCamera] = useState(() => read('ns.camera', false))
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSettings = useRef<Partial<Settings>>({})
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
        if (res.settings) { setSettings(res.settings); setUseCamera(res.settings.cameraByDefault) }
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
    api.leaderboard(cosmosMode)
      .then(r => { setLeaders(r.rows); setPointsOffline(r.offline) })
      .catch(() => setPointsOffline(true))
  }, [cosmosMode])
  useEffect(() => { write('ns.cosmosMode', cosmosMode) }, [cosmosMode])
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
    // Flip it on screen immediately; the server answer reconciles (or rolls back) a moment later.
    const before = goals
    const owner = goals.find(g => g.milestones.some(m => m.id === milestoneId))
    const target = owner?.milestones.find(m => m.id === milestoneId)
    if (owner && target) {
      const done = !target.done
      setGoals(gs => gs.map(g => g.id !== owner.id ? g : {
        ...g, milestones: g.milestones.map(m => m.id === milestoneId ? { ...m, done, brightness: done ? 1 : 0.18 } : m),
      }))
      if (done) sound.twinkle(target.order, true)
    }
    try {
      const res = await api.toggleMilestone(user.id, milestoneId)
      setGoals(gs => byCreated(gs.map(g => (g.id === res.goal.id ? res.goal : g))))
      setStats(res.stats)
    } catch {
      setGoals(before)
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

  // Settings apply instantly and save in the background (debounced for the slider).
  const changeSettings = (patch: Partial<Settings>) => {
    if (!user) return
    setSettings(s => ({ ...s, ...patch }))
    if (patch.cameraByDefault !== undefined && !(focus && focus.status !== 'idle')) setUseCamera(patch.cameraByDefault)
    pendingSettings.current = { ...pendingSettings.current, ...patch }
    setSettingsSaving(true)
    if (settingsTimer.current) clearTimeout(settingsTimer.current)
    settingsTimer.current = setTimeout(() => {
      const body = pendingSettings.current
      pendingSettings.current = {}
      api.saveSettings(user.id, body)
        .then(r => setSettings(r.settings))
        .catch(() => toast('Could not save settings.'))
        .finally(() => setSettingsSaving(false))
    }, 400)
  }

  useEffect(() => { sound.setEnabled(settings.sounds) }, [settings.sounds])
  useEffect(() => {
    if (view !== 'settings') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setView('sky') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])
  useEffect(() => {
    void desktop?.focus.configure?.({ checkSeconds: settings.checkSeconds, notifications: settings.notifications })
      .then(setFocus).catch(() => {})
  }, [settings.checkSeconds, settings.notifications])

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
    <div className={`app view-${view} ${user ? 'has-nav' : ''} ${view === 'sky' && selectedGoal && !discovering ? 'has-panel' : ''} ${desktop ? 'is-desktop' : ''}`} style={{ ['--me' as string]: color }}>
      <Universe
        me={user}
        myGoals={goals}
        bornAt={bornAt}
        focusIndex={focusIndex}
        discovering={discovering}
        understanding={understanding}
        view={view === 'cosmos' ? 'cosmos' : 'sky'}
        nav={!!user}
        others={others}
        myScore={myRow?.points ?? stats.score}
        focusing={focusingGoal}
      />

      <TopBar user={user} stats={stats} points={myRow ?? null} view={view} onView={v => { sound.unlock(); setView(v) }} onMenu={() => setNavOpen(true)} />

      {user && (
        <Sidebar user={user} goals={goals} selected={selected} discovering={discovering} focusingGoalId={focusingGoal}
          view={view} stats={stats} points={myRow ?? null} open={navOpen}
          onSelect={id => { setSelected(id); setView('sky') }} onNew={startNewStar}
          onView={v => { sound.unlock(); setView(v) }} onClose={() => setNavOpen(false)} />
      )}

      {user && view === 'sky' && selectedGoal && !discovering && (
        <div className="left-column">
          <GoalPanel key={selectedGoal.id} goal={selectedGoal} color={color} onToggle={toggleMilestone} focus={focusControls(selectedGoal)}
            onAsk={text => { if (!busy) void send(text) }} />
        </div>
      )}

      {user && view === 'settings' && (
        <SettingsView settings={settings} saving={settingsSaving} desktop={!!desktop} onChange={changeSettings} onClose={() => setView('sky')} />
      )}

      {user && view === 'cosmos' && (
        <>
          <Leaderboard rows={leaders} meId={meId} offline={pointsOffline} mode={cosmosMode} onMode={setCosmosMode} />
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
          suggestions={settings.suggestions ? suggestions[threadKey] ?? [] : []}
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
