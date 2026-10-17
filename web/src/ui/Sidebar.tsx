import type { Goal, PointsRow, Stats, User } from '../types'
import { Plus, Spark } from './icons'
import { formatHours } from './Panels'

export type View = 'sky' | 'cosmos' | 'settings'

type Props = {
  user: User
  goals: Goal[]
  selected: string | null
  discovering: boolean
  focusingGoalId: string | null
  view: View
  stats: Stats
  points: PointsRow | null
  open: boolean
  onSelect: (goalId: string) => void
  onNew: () => void
  onView: (view: View) => void
  onClose: () => void
}

const SettingsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
  </svg>
)

export function Sidebar({ user, goals, selected, discovering, focusingGoalId, view, stats, points, open,
  onSelect, onNew, onView, onClose }: Props) {
  const brainstorm = goals.filter(g => g.status === 'brainstorm')
  const stars = goals.filter(g => g.status !== 'brainstorm')
  const score = points?.points ?? stats.score

  const item = (g: Goal) => {
    const active = view === 'sky' && g.id === selected && !discovering
    return (
      <li key={g.id}>
        <button className={`nav-goal ${active ? 'is-active' : ''}`} onClick={() => { onSelect(g.id); onClose() }} title={g.title}>
          <span className="nav-dot" style={{ background: user.color, opacity: 0.3 + g.brightness * 0.7, boxShadow: `0 0 ${3 + g.brightness * 10}px ${user.color}` }} />
          <span className="nav-goal-title">{g.title}</span>
          {focusingGoalId === g.id && <span className="nav-live" title="Focusing now" />}
        </button>
      </li>
    )
  }

  return (
    <>
      <div className={`nav-scrim ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden />
      <aside className={`nav glass ${open ? 'is-open' : ''}`} aria-label="Navigation">
        <div className="nav-brand">
          <span className="brand-mark"><Spark size={15} /></span>
          <span className="brand-name">North Star</span>
        </div>

        <button className={`nav-new ${discovering && view === 'sky' ? 'is-active' : ''}`} onClick={() => { onNew(); onClose() }}>
          <Plus /> New star
        </button>

        <div className="nav-scroll">
          <section className="nav-section">
            <h3 className="nav-label">Brainstorm <span className="nav-count">{brainstorm.length || ''}</span></h3>
            {brainstorm.length > 0
              ? <ul className="nav-list">{brainstorm.map(item)}</ul>
              : <p className="nav-empty">Ideas you write down land here as little stars.</p>}
          </section>
          <section className="nav-section">
            <h3 className="nav-label">Stars <span className="nav-count">{stars.length || ''}</span></h3>
            {stars.length > 0
              ? <ul className="nav-list">{stars.map(item)}</ul>
              : <p className="nav-empty">A star is ready once it knows what success looks like and a first step.</p>}
          </section>
        </div>

        <nav className="nav-views">
          <button className={view === 'settings' ? 'is-active' : ''} onClick={() => { onView('settings'); onClose() }}><SettingsIcon /> Settings</button>
        </nav>

        <div className="nav-me">
          <span className="me-avatar" style={{ background: user.color }}>{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="nav-me-text">
            <span className="nav-me-name">{user.name}</span>
            <span className="nav-me-stats mono">{score.toLocaleString()} pts · {formatHours(points?.focusedMinutes ?? stats.focusedMinutes)}</span>
          </span>
        </div>
      </aside>
    </>
  )
}
