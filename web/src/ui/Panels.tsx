import { useState } from 'react'
import type { PointsRow, Stats, User } from '../types'
import { Clock, Flame, Spark } from './icons'

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
          <span className="v2-badge" title="North Star v2: panels built for each goal">v2</span>
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

export function Leaderboard({ rows, meId, offline, mode, onMode, onPick }: {
  rows: PointsRow[]; meId?: string | null; offline: boolean; mode: 'real' | 'demo'; onMode: (m: 'real' | 'demo') => void
  onPick: (playerId: string) => void
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
          <li key={r.id} className={`rank ${r.id === meId ? 'is-me' : ''}`} role="button" tabIndex={0}
            onClick={() => onPick(r.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.id) } }}>
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

