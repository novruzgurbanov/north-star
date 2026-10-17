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
  collapsed: boolean
  onCollapse: () => void
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

export function Sidebar({ user, goals, selected, discovering, focusingGoalId, view, stats, points, open, collapsed, onCollapse,
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
          <span className="nav-goal-title nav-text">{g.title}</span>
          {focusingGoalId === g.id && <span className="nav-live" title="Focusing now" />}
        </button>
      </li>
    )
  }

  return (
    <>
      <div className={`nav-scrim ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden />
      <aside className={`nav glass ${open ? 'is-open' : ''} ${collapsed ? 'is-collapsed' : ''}`} aria-label="Navigation">
        <div className="nav-brand">
          <span className="brand-mark"><Spark size={15} /></span>
          <span className="brand-name nav-text">North Star</span>
          <span className="v2-badge nav-text" title="North Star v2: panels built for each goal">v2</span>
          <button className="nav-collapse" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
              style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .3s cubic-bezier(0.22, 1, 0.36, 1)' }}>
              <rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15M15.5 10l-2 2 2 2" />
            </svg>
          </button>
        </div>

        <button className={`nav-new ${discovering && view === 'sky' ? 'is-active' : ''}`} onClick={() => { onNew(); onClose() }} title="New star">
          <Plus /> <span className="nav-text">New star</span>
        </button>

        <div className="nav-scroll">
          <section className="nav-section">
            <h3 className="nav-label"><span className="nav-text">Brainstorm</span> <span className="nav-count nav-text">{brainstorm.length || ''}</span></h3>
            {brainstorm.length > 0
              ? <ul className="nav-list">{brainstorm.map(item)}</ul>
              : <p className="nav-empty nav-text">Ideas you write down land here as little stars.</p>}
          </section>
          <section className="nav-section">
            <h3 className="nav-label"><span className="nav-text">Stars</span> <span className="nav-count nav-text">{stars.length || ''}</span></h3>
            {stars.length > 0
              ? <ul className="nav-list">{stars.map(item)}</ul>
              : <p className="nav-empty nav-text">A star is ready once it knows what success looks like and a first step.</p>}
          </section>
        </div>

        <nav className="nav-views">
          <button className={view === 'settings' ? 'is-active' : ''} onClick={() => { onView('settings'); onClose() }} title="Settings"><SettingsIcon /> <span className="nav-text">Settings</span></button>
        </nav>

        <div className="nav-me">
          <span className="me-avatar" style={{ background: user.color }}>{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="nav-me-text nav-text">
            <span className="nav-me-name">{user.name}</span>
            <span className="nav-me-stats mono">{score.toLocaleString()} pts · {formatHours(points?.focusedMinutes ?? stats.focusedMinutes)}</span>
          </span>
        </div>
      </aside>
    </>
  )
}
