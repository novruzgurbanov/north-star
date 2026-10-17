import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { sound } from './sound'
import { DEFAULT_SETTINGS, type ChatMessage, type EntryValues, type FocusState, type Goal, type NextStep, type PointsRow, type Recap, type Settings, type Stats, type User, type WidgetOp } from './types'
import { Universe } from './scene/Universe'
import { Sidebar, type View } from './ui/Sidebar'
import { SettingsView } from './ui/SettingsView'
import { ChatDock } from './ui/ChatDock'
import { Leaderboard, Onboarding, TopBar } from './ui/Panels'
import { GoalPanel } from './ui/GoalPanel'
import { SessionDock } from './ui/SessionDock'
import { PlayerCard } from './ui/PlayerCard'
import type { TrackHandlers } from './ui/PanelTrack'
import { applyWidgetOp, describeValues, logWidget } from './ui/widgets/data'

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
// The session lengths a goal's panel offers in its focus widget, if it has one.
const panelDurations = (goal: Goal) => {
  const w = goal.panel?.widgets.find(x => x.type === 'focus_session')
  return w?.type === 'focus_session' ? w.minutes : undefined
}
const nowSec = () => performance.now() / 1000

type ToastAction = { label: string; run: () => void }
type Toast = { id: number; text: string; action?: ToastAction }

// How long a toast stays: plain, with an action (Undo), and after an action toast is let go (matches .is-resumed).
const TOAST_MS = 3600
const TOAST_ACTION_MS = 6600
const TOAST_RESUME_MS = 3000

/**
 * One toast. A toast with an action holds still while it is pointed at or has keyboard focus (no timeout,
 * no fade), so its action can always be reached; once let go it fades out a few seconds later.
 */
function ToastView({ toast, onHold, onAction }: { toast: Toast; onHold: (held: boolean) => void; onAction: () => void }) {
  const [mode, setMode] = useState<'' | 'is-held' | 'is-resumed'>('')
  const over = useRef({ pointer: false, focus: false, closed: false })
  // Where focus was before it came into the toast; it goes back there when the toast closes under it.
  const cameFrom = useRef<HTMLElement | null>(null)
  const hold = (patch: Partial<{ pointer: boolean; focus: boolean }>) => {
    if (over.current.closed) return // its action ran; App already dropped it
    const before = over.current.pointer || over.current.focus
    over.current = { ...over.current, ...patch }
    const held = over.current.pointer || over.current.focus
    if (held === before) return
    onHold(held)
    setMode(held ? 'is-held' : 'is-resumed')
  }
  if (!toast.action) return <div className="toast glass">{toast.text}</div>
  return (
    <div className={`toast glass has-action ${mode}`}
      onPointerEnter={() => hold({ pointer: true })} onPointerLeave={() => hold({ pointer: false })}
      onFocus={e => {
        if (!over.current.focus) cameFrom.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null
        hold({ focus: true })
      }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold({ focus: false }) }}>
      {toast.text}
      <button className="toast-action" onClick={e => {
        const back = e.currentTarget === document.activeElement ? cameFrom.current : null
        over.current.closed = true
        onAction()
        if (back?.isConnected) back.focus()
      }}>{toast.action.label}</button>
    </div>
  )
}

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
  const [navCollapsed, setNavCollapsed] = useState(() => read('ns.navCollapsed', false))
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSettings = useRef<Partial<Settings>>({})
  const [bornAt, setBornAt] = useState<Record<string, number>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [nextSteps, setNextSteps] = useState<Record<string, NextStep | 'loading'>>({})
  const [recaps, setRecaps] = useState<Record<string, Recap | 'loading' | null>>({})
  const [panelHidden, setPanelHidden] = useState(true)
  const [storedFor, setStoredFor] = useState<string | null>(null)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [player, setPlayer] = useState<PointsRow | null>(null)
  const lastSessionEnd = useRef<string | null>(null)
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({})
  const busyRef = useRef(false)
  // v2 panels: first designs in flight per goal, and a guard so background refreshes never undo a fresher panel edit.
  const [designs, setDesigns] = useState<Record<string, 'working' | 'failed'>>({})
  const designAsked = useRef(new Set<string>())
  const panelBusy = useRef(0)
  const panelSeq = useRef(0)
  const opSeq = useRef<Record<string, number>>({})
  const panelQueue = useRef<Record<string, Promise<unknown>>>({})
  // Panel versions where the server said there is nothing to undo; the "Undo last change" link hides there.
  const [noUndo, setNoUndo] = useState<Record<string, number>>({})
  // The latest goals, for callbacks that outlive their render (a toast's Undo runs seconds later).
  const goalsRef = useRef(goals)
  goalsRef.current = goals

  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const dropToast = useCallback((id: number) => {
    clearTimeout(toastTimers.current.get(id))
    toastTimers.current.delete(id)
    setToasts(t => t.filter(x => x.id !== id))
  }, [])
  const dropToastIn = useCallback((id: number, ms: number) => {
    clearTimeout(toastTimers.current.get(id))
    toastTimers.current.set(id, setTimeout(() => dropToast(id), ms))
  }, [dropToast])

  // A toast with an action (Undo) stays a little longer and can be clicked.
  const toast = useCallback((text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text, action }])
    dropToastIn(id, action ? TOAST_ACTION_MS : TOAST_MS)
  }, [dropToastIn])

  // While an action toast is held it has no timer; let go, it gets a fresh short one.
  const holdToast = (id: number, held: boolean) => {
    if (!held) return dropToastIn(id, TOAST_RESUME_MS)
    clearTimeout(toastTimers.current.get(id))
    toastTimers.current.delete(id)
  }

  const applyGoals = useCallback((next: Goal[]) => setGoals(byCreated(next)), [])

  // Load the signed-in user's sky, and their saved conversations.
  useEffect(() => {
    if (!user) return
    setThreads(read(`ns.threads.${user.id}`, {}))
    setUnderstanding(read(`ns.understanding.${user.id}`, 0))
    setStoredFor(user.id)
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

  // Save only after this user's saved chats have been loaded into state; otherwise the first render's
  // empty state would overwrite them (React runs mount effects twice in development).
  useEffect(() => { if (user && storedFor === user.id) write(`ns.threads.${user.id}`, threads) }, [threads, user, storedFor])
  useEffect(() => { if (user && storedFor === user.id) write(`ns.understanding.${user.id}`, understanding) }, [understanding, user, storedFor])

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
      if (busyRef.current || panelBusy.current > 0) return
      const seq = panelSeq.current
      api.getUser(user.id).then(res => {
        if (seq !== panelSeq.current) return // a panel change landed while this was in flight; this copy is older
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
      const ended = state.lastSession
      if (ended && ended.endedAt !== lastSessionEnd.current) {
        lastSessionEnd.current = ended.endedAt
        recapRef.current(ended)
      }
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
  // Overview (a goal exists but its panel is closed): the sky is clear and the input writes down a new star.
  const overview = loaded && view === 'sky' && selected !== null && panelHidden
  const chatGoalId = overview ? null : selected
  const threadKey = chatGoalId ?? NEW
  const messages = threads[threadKey] ?? []
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
    const goalId = chatGoalId ?? undefined
    const msgs: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setThread(key, msgs)
    setSuggestions(s => ({ ...s, [key]: [] }))
    setBusy(true)
    busyRef.current = true
    try {
      const res = await api.chat(user.id, msgs, goalId)
      const withReply: ChatMessage[] = [...msgs, { role: 'assistant', content: res.reply }]
      // The reply's goals are read after every coach action, so they are the freshest copy: a background
      // refresh already in flight must not land on top of them.
      panelSeq.current++
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
        setPanelHidden(false)
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
          toast('Your star is ready. Next: a panel to track it.')
        } else if (e.type === 'entry_logged') {
          setTimeout(() => sound.twinkle(3 + i), 150 * i)
          const owner = res.goals.find(g => g.id === e.goalId)
          const log = owner ? logWidget(owner, e.entry.widgetId) : null
          const what = log ? describeValues(log.fields, e.entry.values) : ''
          toast(`Logged${log ? ` in “${log.title}”` : ''}${what ? `: ${what}` : ''}`)
        } else if (e.type === 'panel_updated') {
          // e.goal is a snapshot from right after the edit; res.goals (applied above) also has the entries
          // and milestones from any actions that came after it in the same reply.
          setTimeout(() => sound.twinkle(4 + i), 150 * i)
          toast(e.change || 'Your panel was updated.', undoAction(e.goalId))
        }
      })
    } catch {
      toast('The stars went quiet. Check the server and try again.')
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  // ---------- v2: AI-built goal panels (PANELS.md) ----------

  /** Swaps in a fresher copy of one goal returned by a panel or entry call. */
  const putGoal = (goal: Goal) => {
    panelSeq.current++
    setGoals(gs => byCreated(gs.map(g => (g.id === goal.id ? goal : g))))
  }

  /** Runs a panel request while holding off the background refresh (its older copy would undo this change). */
  async function panelCall<T>(run: () => Promise<T>): Promise<T> {
    panelBusy.current++
    panelSeq.current++
    try { return await run() } finally { panelBusy.current--; panelSeq.current++ }
  }

  /**
   * Runs a request that rewrites a goal's panel after the ones already sent for that goal have finished.
   * The server reads the spec, changes it and saves it whole, so two at once would each save over the other.
   */
  function queuePanel<T>(goalId: string, run: () => Promise<T>): Promise<T> {
    const before = panelQueue.current[goalId] ?? Promise.resolve()
    const next = panelCall(() => before.catch(() => {}).then(run))
    panelQueue.current[goalId] = next
    return next
  }
  // Each queued write gets a number; only the latest one's reply is applied (or, if it fails, refreshes),
  // since earlier replies don't know about the writes queued after them.
  const nextOp = (goalId: string) => (opSeq.current[goalId] = (opSeq.current[goalId] ?? 0) + 1)
  const isLatest = (goalId: string, n: number) => opSeq.current[goalId] === n

  // After a failed manual edit, take the server's word for what the panel looks like.
  const refreshGoals = () => {
    if (!user) return
    api.getUser(user.id).then(res => { panelSeq.current++; applyGoals(res.goals); setStats(res.stats) }).catch(() => {})
  }

  // Asked once per goal; a failure shows a retry instead of asking again on every render.
  const designPanel = (goalId: string, retry = false) => {
    if (!user || (designAsked.current.has(goalId) && !retry)) return
    designAsked.current.add(goalId)
    setDesigns(d => ({ ...d, [goalId]: 'working' }))
    panelCall(() => api.designPanel(user.id, goalId))
      .then(res => {
        putGoal(res.goal)
        setDesigns(d => { const copy = { ...d }; delete copy[goalId]; return copy })
        // A soft chime for each card as it materializes.
        res.goal.panel?.widgets.slice(0, 5).forEach((_, i) => setTimeout(() => sound.twinkle(i), 140 + i * 90))
      })
      .catch(() => setDesigns(d => ({ ...d, [goalId]: 'failed' })))
  }

  const undoPanel = (goalId: string) => {
    if (!user) return
    const version = goalsRef.current.find(g => g.id === goalId)?.panel?.version ?? 0
    const n = nextOp(goalId)
    queuePanel(goalId, () => api.undoPanel(user.id, goalId))
      .then(res => { if (isLatest(goalId, n)) putGoal(res.goal); toast('Panel restored.') })
      .catch(err => {
        // The server tells the two 409s apart by code: 'empty' really has no undo left at this version,
        // 'conflict' means the panel moved under the undo (another window) and another click may win.
        const code = err instanceof ApiError ? err.code : undefined
        if (code === 'empty') setNoUndo(nu => ({ ...nu, [goalId]: version }))
        toast(
          code === 'empty' ? 'Nothing left to undo.'
            : code === 'conflict' ? 'The panel just changed. Try Undo again.'
            : 'Could not undo that change.'
        )
        if (isLatest(goalId, n)) refreshGoals()
      })
  }
  const undoAction = (goalId: string): ToastAction => ({ label: 'Undo', run: () => undoPanel(goalId) })

  const editPanel = async (goalId: string, instruction: string) => {
    if (!user) return false
    const n = nextOp(goalId)
    try {
      const res = await queuePanel(goalId, () => api.editPanel(user.id, goalId, instruction))
      if (isLatest(goalId, n)) putGoal(res.goal)
      sound.twinkle(4)
      toast(res.change || 'Your panel was updated.', undoAction(goalId))
      return true
    } catch {
      toast('Could not change the panel. Try again.')
      if (isLatest(goalId, n)) refreshGoals()
      return false
    }
  }

  // Manual edits show at once (on the latest state, so quick edits stack) and reach the server one at a time.
  // Only the latest reply for a goal is applied, so quick moves don't flicker back.
  const widgetOp = (goalId: string, widgetId: string, op: WidgetOp) => {
    if (!user) return
    const title = goalsRef.current.find(g => g.id === goalId)?.panel?.widgets.find(w => w.id === widgetId)?.title ?? 'card'
    const n = nextOp(goalId)
    panelSeq.current++
    setGoals(gs => gs.map(g => (g.id === goalId && g.panel ? { ...g, panel: applyWidgetOp(g.panel, widgetId, op) } : g)))
    if (op.kind === 'toggle_item') sound.tick()
    queuePanel(goalId, () => api.widgetOp(user.id, goalId, widgetId, op))
      .then(res => {
        if (isLatest(goalId, n)) putGoal(res.goal)
        if (op.kind === 'remove') toast(`Removed “${title}”.`, undoAction(goalId)) // layout edits are undoable too
      })
      .catch(() => {
        toast('Could not change that card.')
        if (isLatest(goalId, n)) refreshGoals()
      })
  }

  const logEntry = async (goalId: string, widgetId: string, values: EntryValues, proof?: string) => {
    if (!user) throw new Error('Not signed in')
    sound.unlock()
    const res = await panelCall(() => api.createEntry(user.id, goalId, { widgetId, values, proof }))
    putGoal(res.goal)
    setStats(res.stats)
    if (res.points) setMyPoints(res.points)
    const verified = res.entry.proof === 'verified'
    sound.twinkle(verified ? 4 : 2, verified)
    return res.entry
  }

  const deleteEntry = async (goalId: string, entryId: string) => {
    if (!user) return
    panelSeq.current++
    setGoals(gs => gs.map(g => (g.id === goalId ? { ...g, entries: (g.entries ?? []).filter(e => e.id !== entryId) } : g)))
    try {
      const res = await panelCall(() => api.deleteEntry(user.id, goalId, entryId))
      putGoal(res.goal)
      setStats(res.stats)
    } catch {
      toast('Could not delete that entry.')
      refreshGoals()
    }
  }

  const trackFor = (goal: Goal): TrackHandlers => ({
    design: designs[goal.id] ?? null,
    next: nextSteps[goal.id] ?? null,
    onRedesign: () => designPanel(goal.id, true),
    onEdit: instruction => editPanel(goal.id, instruction),
    // Any change after the first design may be undoable; the server's 409 hides the link at that version.
    canUndo: !!goal.panel && goal.panel.version > 1 && noUndo[goal.id] !== goal.panel.version,
    onUndo: () => undoPanel(goal.id),
    onOp: (widgetId, op) => widgetOp(goal.id, widgetId, op),
    onLog: (widgetId, values, proof) => logEntry(goal.id, widgetId, values, proof),
    onDeleteEntry: entryId => deleteEntry(goal.id, entryId),
    onRefreshNext: () => fetchNext(goal.id, true),
  })

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

  const startSession = (goal: Goal, task: string, minutes: number) => {
    if (!user || !desktop) return
    sound.unlock()
    setRecaps(r => ({ ...r, [goal.id]: null }))
    void desktop.focus.start({ userId: user.id, goalId: goal.id, goalTitle: goal.title, camera: useCamera, task, plannedMinutes: minutes })
      .then(setFocus)
      .catch(() => toast('Could not start the focus session.'))
  }

  const sessionDock = (goal: Goal) => (
    <SessionDock
      goal={goal}
      focus={focus}
      desktop={!!desktop}
      camera={focus?.status && focus.status !== 'idle' ? focus.cameraEnabled : useCamera}
      next={nextSteps[goal.id] ?? null}
      recap={recaps[goal.id] ?? null}
      durations={panelDurations(goal)}
      onCamera={enabled => {
        setUseCamera(enabled)
        if (focus && focus.status !== 'idle') void desktop?.focus.setCamera(enabled).then(setFocus)
      }}
      onStart={(task, minutes) => startSession(goal, task, minutes)}
      onPause={() => void desktop?.focus.pause().then(setFocus)}
      onResume={() => void desktop?.focus.resume().then(setFocus)}
      onStop={() => void desktop?.focus.stop().then(setFocus)}
      onRefreshNext={() => fetchNext(goal.id, true)}
      onAsk={text => { if (!busy) void send(text) }}
      onLightMilestone={id => { void toggleMilestone(id); setRecaps(r => ({ ...r, [goal.id]: null })); fetchNext(goal.id, true) }}
      onDismissRecap={() => { setRecaps(r => ({ ...r, [goal.id]: null })); fetchNext(goal.id, true) }}
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
  useEffect(() => { write('ns.navCollapsed', navCollapsed) }, [navCollapsed])
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

  const fetchNext = (goalId: string, force = false) => {
    if (!user) return
    if (!force && nextSteps[goalId]) return
    setNextSteps(n => ({ ...n, [goalId]: 'loading' }))
    api.nextStep(user.id, goalId)
      .then(step => setNextSteps(n => ({ ...n, [goalId]: step })))
      .catch(() => setNextSteps(n => { const copy = { ...n }; delete copy[goalId]; return copy }))
  }

  function requestRecap(ended: NonNullable<FocusState['lastSession']>) {
    if (!user || !ended.goalId) return
    const goalId = ended.goalId
    setRecaps(r => ({ ...r, [goalId]: 'loading' }))
    sound.twinkle(3, true)
    api.recap({
      userId: user.id, goalId, task: ended.task || ended.goalTitle, plannedMinutes: ended.plannedMinutes ?? 25,
      activeSeconds: Math.round(ended.activeSeconds), verifiedSeconds: Math.round(ended.verifiedSeconds), completed: ended.completed,
      checks: (ended.history ?? []).slice(-200).map(c => ({ at: c.at, verdict: c.verdict, reason: (c.reason || '').slice(0, 200) })),
    })
      .then(recap => {
        setRecaps(r => ({ ...r, [goalId]: recap }))
        if (user) api.getUser(user.id).then(res => { applyGoals(res.goals); setStats(res.stats) }).catch(() => {})
      })
      .catch(() => { setRecaps(r => ({ ...r, [goalId]: null })); toast('Session saved, but the recap could not be written.') })
  }

  const recapRef = useRef(requestRecap)
  recapRef.current = requestRecap

  useEffect(() => {
    if (overview) { setThreads(t => (t[NEW]?.length ? { ...t, [NEW]: [] } : t)); setSuggestions(s => ({ ...s, [NEW]: [] })) }
  }, [overview])

  // A ready star without a panel gets one designed the first time its panel is opened.
  const goalPanelOpen = view === 'sky' && !!selectedGoal && !discovering && !panelHidden
  useEffect(() => {
    if (!goalPanelOpen || !selectedGoal || selectedGoal.status === 'brainstorm' || selectedGoal.panel) return
    designPanel(selectedGoal.id)
  }, [goalPanelOpen, selectedGoal?.id, selectedGoal?.status, !!selectedGoal?.panel]) // eslint-disable-line react-hooks/exhaustive-deps

  // Suggest the next task as soon as a ready star is open and nothing is running on it.
  useEffect(() => {
    if (!selectedGoal || selectedGoal.status === 'brainstorm' || discovering) return
    if (focus && focus.status !== 'idle' && focus.goalId === selectedGoal.id) return
    fetchNext(selectedGoal.id)
  }, [selectedGoal?.id, selectedGoal?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The open sky between the sidebar, the goal panel / leaderboard and the chat dock; the scene centres in it.
  const narrowScreen = viewport.w < 900
  const navW = user && !narrowScreen ? (navCollapsed ? 60 : 244) + 12 : 0
  const panelShown = view === 'sky' && !!selectedGoal && !discovering && !panelHidden && !narrowScreen
  const frame = {
    left: navW + (panelShown ? 356 : 0),
    right: view === 'cosmos' && !narrowScreen ? 376 : 0,
    top: 64,
    bottom: view === 'sky' && user ? 150 : 40,
  }

  const deleteGoal = async (goal: Goal) => {
    if (!user) return
    if (focus && focus.status !== 'idle' && focus.goalId === goal.id) await desktop?.focus.stop().catch(() => null)
    try {
      const res = await api.deleteGoal(user.id, goal.id)
      applyGoals(res.goals)
      setStats(res.stats)
      setThreads(t => { const copy = { ...t }; delete copy[goal.id]; return copy })
      setNextSteps(n => { const copy = { ...n }; delete copy[goal.id]; return copy })
      setRecaps(r => { const copy = { ...r }; delete copy[goal.id]; return copy })
      // Back to the overview of what is left, or to the new-star screen if nothing is.
      const rest = byCreated(res.goals)
      setSelected(rest.length ? rest[rest.length - 1].id : null)
      setForgeIndex(rest.length)
      setPanelHidden(true)
      toast(`“${goal.title}” was deleted.`)
    } catch {
      toast('Could not delete that star.')
    }
  }

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
    <div className={`app view-${view} ${user ? 'has-nav' : ''} ${view === 'sky' && selectedGoal && !discovering && !panelHidden ? 'has-panel' : ''} ${desktop ? 'is-desktop' : ''} ${navCollapsed ? 'nav-collapsed' : ''} ${user && view === 'sky' && discovering && messages.length === 0 ? 'is-forging' : ''}`} style={{ ['--me' as string]: color }}>
      <Universe
        me={user}
        myGoals={goals}
        bornAt={bornAt}
        focusGoalId={view === 'sky' && selectedGoal && !discovering && !panelHidden ? selectedGoal.id : null}
        forgeIndex={forgeIndex}
        discovering={discovering}
        understanding={understanding}
        view={view === 'cosmos' ? 'cosmos' : 'sky'}
        frame={frame}
        onPickGoal={id => { setSelected(id); setPanelHidden(false); setView('sky') }}
        others={others}
        myScore={myRow?.points ?? stats.score}
        focusing={focusingGoal}
        onPickPlayer={id => setPlayer(others.find(r => r.id === id) ?? null)}
      />

      <TopBar user={user} stats={stats} points={myRow ?? null} view={view} onView={v => { sound.unlock(); setView(v) }} onMenu={() => setNavOpen(true)} />

      {user && (
        <Sidebar user={user} goals={goals} selected={selected} discovering={discovering} focusingGoalId={focusingGoal}
          view={view} stats={stats} points={myRow ?? null} open={navOpen}
          collapsed={navCollapsed} onCollapse={() => setNavCollapsed(c => !c)}
          onSelect={id => {
            // Pressing the open goal again hides its panel; any other goal opens it.
            if (id === selected && view === 'sky' && !discovering) setPanelHidden(h => !h)
            else { setSelected(id); setPanelHidden(false) }
            setView('sky')
          }} onNew={startNewStar}
          onView={v => { sound.unlock(); setView(v) }} onClose={() => setNavOpen(false)} />
      )}

      {/* Asking for a new goal: soften the sky behind the question so stars and labels don't mix with it. */}
      <div className={`forge-scrim ${user && view === 'sky' && discovering && messages.length === 0 ? 'is-on' : ''}`} aria-hidden />

      {user && view === 'sky' && selectedGoal && !discovering && !panelHidden && (
        <div className="left-column">
          <GoalPanel key={selectedGoal.id} goal={selectedGoal} color={color} onToggle={toggleMilestone} dock={sessionDock(selectedGoal)}
            focusing={focusingGoal === selectedGoal.id} focus={focus}
            sessionHere={!!focus && focus.status !== 'idle' && focus.goalId === selectedGoal.id} hasRecap={!!recaps[selectedGoal.id]}
            onAsk={text => { if (!busy) void send(text) }} track={trackFor(selectedGoal)}
            onDelete={() => deleteGoal(selectedGoal)} />
        </div>
      )}

      {user && view === 'settings' && (
        <SettingsView settings={settings} saving={settingsSaving} desktop={!!desktop} onChange={changeSettings} onClose={() => setView('sky')}
          color={color} goals={goals}
          onColor={c => {
            if (!user) return
            const next = { ...user, color: c }
            setUser(next); write('ns.user', next)
            api.setColor(user.id, c).catch(() => toast('Could not save your color.'))
          }}
          onGoalPublic={(goalId, isPublic) => {
            if (!user) return
            setGoals(gs => gs.map(g => (g.id === goalId ? { ...g, public: isPublic } : g)))
            api.setGoalPublic(user.id, goalId, isPublic)
              .then(r => setGoals(gs => byCreated(gs.map(g => (g.id === r.goal.id ? r.goal : g)))))
              .catch(() => { toast('Could not change that goal’s visibility.'); setGoals(gs => gs.map(g => (g.id === goalId ? { ...g, public: !isPublic } : g))) })
          }} />
      )}

      {user && view === 'cosmos' && (
        <>
          <Leaderboard rows={leaders} meId={meId} offline={pointsOffline} mode={cosmosMode} onMode={setCosmosMode}
            onPick={id => setPlayer(leaders.find(r => r.id === id) ?? null)} />
          {player && <PlayerCard player={player} you={player.id === meId} onClose={() => setPlayer(null)} />}
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
          overview={overview}
        />
      )}

      {!user && <Onboarding onSubmit={createUser} />}

      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <ToastView key={t.id} toast={t} onHold={held => holdToast(t.id, held)}
            onAction={() => { dropToast(t.id); t.action?.run() }} />
        ))}
      </div>
    </div>
  )
}
