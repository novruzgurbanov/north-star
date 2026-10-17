import { useState, type ReactNode } from 'react'
import type { Goal, PointsRow, Stats, User } from '../types'
import { Calendar, Clock, Flame, Plus, Spark } from './icons'

export function TopBar({ user, stats, points, view, onView, onMenu }: {
  user: User | null; stats: Stats; points: PointsRow | null
  view: 'sky' | 'cosmos' | 'settings'; onView: (v: 'sky' | 'cosmos') => void; onMenu: () => void
}) {
  const score = points?.points ?? stats.score
  const streak = points?.streak ?? stats.streak
  const minutes = points?.focusedMinutes ?? stats.focusedMinutes
  return (
    <header className="topbar">
      {user ? (
        <span className="topbar-lead">
          <button className="menu-btn glass" onClick={onMenu} aria-label="Open navigation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h10" /></svg>
          </button>
        </span>
      ) : (
        <div className="brand">
          <span className="brand-mark"><Spark size={15} /></span>
          <span className="brand-name">North Star</span>
        </div>
      )}
      {user ? (
        <nav className="segmented glass" aria-label="View">
          <button className={view === 'sky' ? 'is-active' : ''} onClick={() => onView('sky')}>My sky</button>
          <button className={view === 'cosmos' ? 'is-active' : ''} onClick={() => onView('cosmos')}>Cosmos</button>
        </nav>
      ) : <span />}
      {user ? (
        <div className="me glass">
          <span className="me-stat" title={points ? 'Points on the shared leaderboard' : 'Score'}><Spark size={12} /> {score.toLocaleString()}</span>
          <span className="me-stat" title="Day streak"><Flame /> {streak}</span>
          <span className="me-stat hide-narrow" title={points ? 'Verified focus time' : 'Focused time'}><Clock /> {formatHours(minutes)}</span>
        </div>
      ) : <span />}
    </header>
  )
}

const KIND_LABEL: Record<string, string> = {
  motivation: 'Why', obstacle: 'In the way', distraction: 'Pulls me off track',
  on_track: 'Working looks like', action: 'Action', subgoal: 'Sub-goal',
}

const EXTRA_PROMPTS = [
  { kind: 'distraction', label: 'What pulls you off track', ask: 'Let’s note what usually pulls me off track.' },
  { kind: 'on_track', label: 'What working on it looks like', ask: 'Let’s note what working on this looks like on my screen.' },
]

const DETAIL_PROMPTS: Record<'success' | 'steps' | 'why', { label: string; ask: string }> = {
  success: { label: 'What success looks like', ask: 'Let’s add what success looks like.' },
  steps: { label: 'First steps', ask: 'Let’s add the first steps.' },
  why: { label: 'Why it matters', ask: 'Let’s add why this matters to me.' },
}

export function GoalPanel({ goal, color, onToggle, focus, onAsk }: {
  goal: Goal; color: string; onToggle: (milestoneId: string) => void; focus: ReactNode; onAsk: (text: string) => void
}) {
  const little = goal.status === 'brainstorm'
  const missing = goal.missing ?? []
  // The goal's "why" is shown above; don't repeat the motivation it came from.
  const details = (goal.details ?? []).filter(d => !(d.kind === 'motivation' && d.text === goal.why))
  const extras = EXTRA_PROMPTS.filter(p => !(goal.details ?? []).some(d => d.kind === p.kind))
  const [pending, setPending] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const ms = [...goal.milestones].sort((a, b) => a.order - b.order)
  const done = ms.filter(m => m.done).length
  const nextId = ms.find(m => !m.done)?.id

  return (
    <aside className="panel glass goal-panel" style={{ ['--star' as string]: color }}>
      <div className="eyebrow">{little ? 'Little star · Brainstorm' : 'Your star'}</div>
      <h2 className="panel-title">{goal.title}</h2>
      {goal.why && <p className="panel-why">{goal.why}</p>}
      <div className="chips">
        {goal.deadline && <span className="chip"><Calendar /> {formatDeadline(goal.deadline)}</span>}
        <span className="chip"><Spark size={11} /> {Math.round(goal.brightness * 100)}% bright</span>
      </div>
      {goal.successLooksLike && (
        <p className="panel-success"><span>Success looks like</span>{goal.successLooksLike}</p>
      )}

      {details.length > 0 && (
        <ul className="known">
          {details.map(d => (
            <li key={d.id} className={`known-item kind-${d.kind}`}>
              <span className="known-kind">{KIND_LABEL[d.kind] ?? d.kind}</span>
              <span className="known-text">{d.text}</span>
            </li>
          ))}
        </ul>
      )}

      {(missing.length > 0 || extras.length > 0) && (
        <div className="details">
          <div className="progress-head"><span>{little ? 'Grow this star' : 'Add more detail'}</span><span className="mono">optional</span></div>
          {missing.map(m => (
            <button key={m} className="detail-add" onClick={() => onAsk(DETAIL_PROMPTS[m].ask)}>
              <Plus size={12} /> {DETAIL_PROMPTS[m].label}
            </button>
          ))}
          {extras.length > 0 && (missing.length === 0 || showMore
            ? extras.map(p => (
              <button key={p.kind} className="detail-add" onClick={() => onAsk(p.ask)}>
                <Plus size={12} /> {p.label}
              </button>
            ))
            : <button className="detail-more" onClick={() => setShowMore(true)}>More details…</button>)}
        </div>
      )}

      {ms.length > 0 && (
        <>
          <div className="progress">
            <div className="progress-head">
              <span>Milestones</span>
              <span className="mono">{done} / {ms.length} lit</span>
            </div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${(done / ms.length) * 100}%` }} /></div>
          </div>

          <ul className="milestones">
            {ms.map(m => (
              <li key={m.id}>
                <button
                  className={`milestone ${m.done ? 'is-done' : ''} ${m.id === nextId ? 'is-next' : ''}`}
                  disabled={pending === m.id}
                  onClick={async () => { setPending(m.id); try { await onToggle(m.id) } finally { setPending(null) } }}
                >
                  <span className="milestone-star" aria-hidden><Spark size={12} /></span>
                  <span className="milestone-title">{m.title}</span>
                  {m.id === nextId && <span className="milestone-next">next</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {little
        ? <p className="focus-note">Add what success looks like and a first step, and this star is ready for focus sessions.</p>
        : focus}
    </aside>
  )
}

export function Leaderboard({ rows, meId, offline, mode, onMode }: {
  rows: PointsRow[]; meId?: string | null; offline: boolean; mode: 'real' | 'demo'; onMode: (m: 'real' | 'demo') => void
}) {
  return (
    <aside className="panel glass leaderboard">
      <div className="lb-head">
        <div className="eyebrow">The cosmos</div>
        <div className="seg seg-small" role="radiogroup" aria-label="Who to show">
          <button role="radio" aria-checked={mode === 'real'} className={mode === 'real' ? 'is-active' : ''} onClick={() => onMode('real')}>Real</button>
          <button role="radio" aria-checked={mode === 'demo'} className={mode === 'demo' ? 'is-active' : ''} onClick={() => onMode('demo')}>Demo</button>
        </div>
      </div>
      <h2 className="panel-title">{mode === 'real' ? 'Who’s shining' : 'Who’s shining (demo)'}</h2>
      <p className="panel-why">One point per verified minute of focus, plus 25 for each day of your streak. Shared with every North Star and Goal Coach player.</p>
      <ol className="ranks">
        {rows.map(r => (
          <li key={r.id} className={`rank ${r.id === meId ? 'is-me' : ''}`}>
            <span className="rank-n mono">{r.rank}</span>
            <span className={`rank-dot ${r.live ? 'is-live' : ''}`} style={{ background: r.color, boxShadow: `0 0 10px ${r.color}` }} title={r.live ? 'Focusing right now' : undefined} />
            <span className="rank-who">
              <span className="rank-name">{r.id === meId ? `${r.name} (you)` : r.name}</span>
              {r.goalTitle && <span className="rank-goal">{r.goalTitle}</span>}
            </span>
            <span className="rank-streak" title="Day streak">{r.streak > 0 && <><Flame size={11} />{r.streak}</>}</span>
            <span className="rank-score mono">{r.points.toLocaleString()}</span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="rank-empty">{offline ? 'The points service is offline. Start it with npm run dev.' : mode === 'real' ? 'No one else has connected yet. Switch to Demo to see a full sky.' : 'The cosmos is quiet. Be the first to focus.'}</li>
        )}
      </ol>
    </aside>
  )
}

export function Onboarding({ onSubmit }: { onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="onboarding">
      <form className="onboarding-card glass" onSubmit={async e => {
        e.preventDefault()
        if (!name.trim()) return
        setBusy(true)
        setError('')
        try { await onSubmit(name.trim()) } catch { setError('Could not reach the server. Is it running?') } finally { setBusy(false) }
      }}>
        <div className="eyebrow">North Star</div>
        <h1 className="onboarding-title">Every goal begins as dust.</h1>
        <p className="panel-why">What should the stars call you?</p>
        <input autoFocus value={name} maxLength={32} placeholder="Your name" onChange={e => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim() || busy}>{busy ? 'Opening the sky…' : 'Enter the cosmos'}</button>
        {error && <p className="form-error">{error}</p>}
      </form>
    </div>
  )
}

export function formatHours(minutes: number) {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = minutes / 60
  return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`
}

function formatDeadline(d: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(d) : null
  if (parsed && !isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return d
}
