import { useEffect, useState } from 'react'
import type { FocusState, Goal, NextStep, Recap } from '../types'
import { Plus, Spark } from './icons'

type Props = {
  goal: Goal
  focus: FocusState | null
  desktop: boolean
  camera: boolean
  next: NextStep | 'loading' | null
  recap: Recap | 'loading' | null
  onCamera: (enabled: boolean) => void
  onStart: (task: string, minutes: number) => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onRefreshNext: () => void
  onAsk: (text: string) => void
  onLightMilestone: (milestoneId: string) => void
  onDismissRecap: () => void
}

const DURATIONS = [15, 25, 50, 90]

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [active])
  return now
}

const mmss = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Ring({ progress, size = 64, children }: { progress: number; size?: number; children?: React.ReactNode }) {
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-fill"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, progress)))} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  )
}

function CameraToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch switch-small">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
      {label}
    </label>
  )
}

export function SessionDock(p: Props) {
  const { goal, focus } = p
  const mine = focus && focus.goalId === goal.id && focus.status !== 'idle' ? focus : null
  const elsewhere = focus && focus.status !== 'idle' && focus.goalId !== goal.id ? focus : null
  const now = useNow(!!mine && mine.status === 'active')
  const suggestion = p.next && p.next !== 'loading' ? p.next : null
  const [task, setTask] = useState('')
  const [minutes, setMinutes] = useState(25)

  // Adopt a fresh AI suggestion unless the user already typed their own task.
  useEffect(() => {
    if (suggestion) { setTask(suggestion.task); setMinutes(suggestion.minutes) }
  }, [suggestion?.task, suggestion?.minutes]) // eslint-disable-line react-hooks/exhaustive-deps

  if (goal.status === 'brainstorm') {
    const missing = goal.missing ?? []
    return (
      <div className="dockcard">
        <div className="dockcard-label">Focus</div>
        <p className="dockcard-text">Add {missing.includes('success') ? 'what success looks like' : ''}{missing.includes('success') && missing.includes('steps') ? ' and ' : ''}{missing.includes('steps') ? 'a first step' : ''} to unlock focus sessions.</p>
        {missing.includes('success') && <button className="detail-add" onClick={() => p.onAsk('Let’s add what success looks like.')}><Plus size={12} /> What success looks like</button>}
        {missing.includes('steps') && <button className="detail-add" onClick={() => p.onAsk('Let’s add the first steps.')}><Plus size={12} /> First steps</button>}
      </div>
    )
  }

  // 1. Live session on this goal
  if (mine) {
    const elapsed = mine.activeSeconds + (mine.activeSince ? Math.max(0, (now - Date.parse(mine.activeSince)) / 1000) : 0)
    const planned = (mine.plannedMinutes ?? 25) * 60
    const check = mine.lastCheck
    const tone = mine.status !== 'active' ? 'idle' : !check ? 'waiting' : check.verdict
    const line = mine.status === 'error' ? mine.error
      : check ? (check.verdict === 'off_track' ? (check.roast || check.nudge || check.reason) : check.reason)
      : 'First glance in a few seconds.'
    return (
      <div className={`dockcard is-live tone-${tone}`}>
        <div className="live-row">
          <Ring progress={elapsed / planned} size={68}>
            <span className="mono ring-time">{mmss(planned - elapsed)}</span>
          </Ring>
          <div className="live-text">
            <div className="dockcard-label">{mine.status === 'paused' ? 'Paused' : mine.status === 'error' ? 'Stopped checking' : 'Focusing on'}</div>
            <div className="live-task">{mine.task ?? goal.title}</div>
            <div className="live-meta mono">{Math.floor(mine.sessionVerifiedSeconds / 60)} min verified · {mine.checks} checks</div>
          </div>
        </div>
        <p className={`live-line ${check?.verdict === 'off_track' && check.roast ? 'is-roast' : ''}`}>
          <span className={`focus-dot tone-${tone}`} aria-hidden /> {line}
        </p>
        {mine.notice && <p className="focus-note is-notice">{mine.notice}</p>}
        <div className="dock-actions">
          {mine.status === 'active'
            ? <button className="ghost" onClick={p.onPause}>Pause</button>
            : <button className="ghost" onClick={p.onResume}>{mine.status === 'error' ? 'Try again' : 'Resume'}</button>}
          <button className="ghost" onClick={p.onStop}>End session</button>
        </div>
        <CameraToggle checked={mine.cameraEnabled} onChange={p.onCamera}
          label={`Camera ${mine.cameraEnabled ? (mine.cameraActive ? 'on' : 'starting…') : 'off'}`} />
      </div>
    )
  }

  // 2. Recap of the session that just ended
  if (p.recap) {
    if (p.recap === 'loading') {
      return <div className="dockcard"><div className="dockcard-label">Session recap</div><p className="dockcard-text typing"><i /><i /><i /></p></div>
    }
    const r = p.recap
    const milestone = r.suggestMilestoneId ? goal.milestones.find(m => m.id === r.suggestMilestoneId && !m.done) : null
    return (
      <div className="dockcard is-recap">
        <div className="dockcard-label">Session recap</div>
        <div className="recap-headline">{r.headline}</div>
        <div className="recap-stats mono">
          {Math.round(r.session.verifiedSeconds / 60)} of {r.session.plannedMinutes} min verified
          {r.session.drifts > 0 && ` · ${r.session.drifts} drift${r.session.drifts > 1 ? 's' : ''}`}
        </div>
        <p className="dockcard-text">{r.summary}</p>
        {r.driftNote && <p className="dockcard-text is-drift">{r.driftNote}</p>}
        {milestone && (
          <button className="focus-start is-soft" onClick={() => p.onLightMilestone(milestone.id)}>
            <Spark size={13} /> Light “{milestone.title}”
          </button>
        )}
        <div className="dock-actions">
          <button className="ghost" onClick={() => { p.onDismissRecap(); p.onStart(r.next.task, r.next.minutes) }} disabled={!p.desktop}>
            Next: {r.next.task} · {r.next.minutes} min
          </button>
          <button className="ghost ghost-quiet" onClick={p.onDismissRecap}>Done</button>
        </div>
      </div>
    )
  }

  // 3. Next up: plan one concrete task, then focus on it
  return (
    <div className="dockcard">
      <div className="dockcard-head">
        <div className="dockcard-label">Next up</div>
        <button className="link-btn" onClick={p.onRefreshNext} disabled={p.next === 'loading'}>
          {p.next === 'loading' ? 'Thinking…' : 'Suggest another'}
        </button>
      </div>
      <input className="task-input" value={task} maxLength={120} placeholder={p.next === 'loading' ? 'Finding your next step…' : 'What will you work on?'}
        onChange={e => setTask(e.target.value)} aria-label="Task for this focus session" />
      {suggestion?.why && task === suggestion.task && <p className="dockcard-why">{suggestion.why}</p>}
      <div className="dur" role="radiogroup" aria-label="Session length">
        {DURATIONS.map(m => (
          <button key={m} role="radio" aria-checked={minutes === m} className={minutes === m ? 'is-active' : ''} onClick={() => setMinutes(m)}>{m} min</button>
        ))}
      </div>
      {elsewhere && <p className="focus-note">You’re focusing on “{elsewhere.goalTitle}”. Starting here ends that session.</p>}
      {p.desktop ? (
        <>
          <button className="focus-start" disabled={!task.trim()} onClick={() => p.onStart(task.trim(), minutes)}>
            <Spark size={13} /> Begin focus · {minutes} min
          </button>
          <CameraToggle checked={p.camera} onChange={p.onCamera} label="Use the camera too" />
        </>
      ) : (
        <p className="focus-note">Focus sessions run in the North Star desktop app, which checks your screen to verify the time.</p>
      )}
    </div>
  )
}
