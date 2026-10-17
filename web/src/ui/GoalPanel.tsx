import { useEffect, useState, type ReactNode } from 'react'
import type { DetailKind, Goal, GoalDetail } from '../types'
import { Calendar, Plus, Spark } from './icons'
import { PanelTrack, type TrackHandlers } from './PanelTrack'
import { ago } from './widgets/data'
import { MilestoneTimeline } from './widgets/MilestoneTimeline'

// Brainstorm stars keep the v1 Plan tab; ready stars get the AI-built Track tab instead.
type Tab = 'plan' | 'track' | 'about'

type Props = {
  goal: Goal
  color: string
  dock: ReactNode
  focusing: boolean
  /** A session on this goal that isn't idle: active, paused or stopped checking */
  sessionHere: boolean
  /** A session recap for this goal is loading or waiting to be read */
  hasRecap: boolean
  track: TrackHandlers
  onToggle: (milestoneId: string) => void
  onAsk: (text: string) => void
  onDelete: () => Promise<void>
}

const PROMPTS = {
  success: { label: 'What success looks like', ask: 'Let’s add what success looks like.' },
  steps: { label: 'First steps', ask: 'Let’s add the first steps.' },
  why: { label: 'Why it matters', ask: 'Let’s add why this matters to me.' },
  subgoal: { label: 'A sub-goal on the way', ask: 'Let’s add a sub-goal: a smaller result on the way.' },
  action: { label: 'A next action', ask: 'Let’s add a concrete next action I can do in one sitting.' },
  distraction: { label: 'What pulls you off track', ask: 'Let’s note what usually pulls me off track.' },
  on_track: { label: 'What working on it looks like', ask: 'Let’s note what working on this looks like on my screen.' },
  obstacle: { label: 'What’s in the way', ask: 'Let’s note what’s in the way.' },
} as const

const ABOUT_GROUPS: { kind: DetailKind; title: string }[] = [
  { kind: 'motivation', title: 'Also driving you' },
  { kind: 'obstacle', title: 'In the way' },
  { kind: 'distraction', title: 'Pulls you off track' },
  { kind: 'on_track', title: 'Working on it looks like' },
]

const Chevron = ({ up }: { up: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden style={{ transform: up ? 'rotate(180deg)' : 'none', transition: 'transform .3s cubic-bezier(0.22, 1, 0.36, 1)' }}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

function formatDeadline(d: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(d) : null
  if (parsed && !isNaN(parsed.getTime())) return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="detail-add" onClick={onClick}><Plus size={12} /> {label}</button>
}

/** The star itself, as a badge: glow grows with brightness, the ring shows milestones lit. */
function StarBadge({ brightness, progress }: { brightness: number; progress: number }) {
  const r = 19
  const c = 2 * Math.PI * r
  return (
    <div className="star-badge" aria-hidden>
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r={r} className="ring-track" />
        <circle cx="23" cy="23" r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
      </svg>
      <span className="star-badge-core" style={{ opacity: 0.45 + brightness * 0.55, transform: `scale(${0.7 + brightness * 0.5})` }}>
        <Spark size={14} />
      </span>
    </div>
  )
}

function readCollapsed() {
  try { return localStorage.getItem('ns.panelCollapsed') === '1' } catch { return false }
}

export function GoalPanel({ goal, color, dock, focusing, sessionHere, hasRecap, track, onToggle, onAsk, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const little = goal.status === 'brainstorm'
  const [chosen, setTab] = useState<Tab>(little ? 'about' : 'track')
  // A star that turns ready while open swaps Plan for Track (and back, should it lose its steps).
  const tab: Tab = chosen === 'about' ? 'about' : little ? 'plan' : 'track'
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [moreAbout, setMoreAbout] = useState(false)

  useEffect(() => {
    try { localStorage.setItem('ns.panelCollapsed', collapsed ? '1' : '0') } catch { /* storage unavailable */ }
  }, [collapsed])

  const ms = [...goal.milestones].sort((a, b) => a.order - b.order)
  const done = ms.filter(m => m.done).length
  const details = goal.details ?? []
  const of = (kind: DetailKind): GoalDetail[] => details.filter(d => d.kind === kind)
  // The agent sometimes files one result as both a milestone and a sub-goal; show it once, as the milestone.
  const milestoneTitles = new Set(ms.map(m => m.title.trim().toLowerCase()))
  const subgoals = of('subgoal').filter(d => !milestoneTitles.has(d.text.trim().toLowerCase()))
  const actions = of('action')
  const sessions = (goal.sessions ?? []).slice(0, 3)
  // On ready stars the session dock lives inside the panel's focus widget. While a session is on (running, paused
  // or stopped checking) or its recap is up, and that widget isn't on screen (About tab, or removed mid-session),
  // the dock stays pinned below, so the session can still be resumed or ended and the recap read.
  const hasFocusWidget = !!goal.panel?.widgets.some(w => w.type === 'focus_session') || (!goal.panel && track.design === 'failed')
  const pinnedDock = little || ((sessionHere || hasRecap) && (!hasFocusWidget || tab !== 'track'))

  const aboutGroups = ABOUT_GROUPS
    .map(g => ({ ...g, items: of(g.kind).filter(d => !(d.kind === 'motivation' && d.text === goal.why)) }))
    .filter(g => g.items.length > 0)
  const aboutExtras = (['distraction', 'on_track', 'obstacle'] as const).filter(k => of(k).length === 0)

  return (
    <aside className={`panel glass goal-panel ${collapsed ? 'is-collapsed' : ''} ${little ? 'is-little' : ''}`} style={{ ['--star' as string]: color }}>
      <header className="gp-head">
        <StarBadge brightness={goal.brightness} progress={ms.length ? done / ms.length : 0} />
        <div className="gp-titles">
          <div className="eyebrow">{little ? 'Little star · Brainstorm' : 'Your star'}</div>
          <h2 className="panel-title">{goal.title}</h2>
        </div>
        <button className="gp-toggle" onClick={() => setCollapsed(c => !c)} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand goal' : 'Collapse goal'} title={collapsed ? 'Expand' : 'Collapse'}>
          <Chevron up={!collapsed} />
        </button>
      </header>

      <div className="gp-meta">
        {ms.length > 0 && <span className="chip"><Spark size={11} /> {done} of {ms.length} lit</span>}
        <span className="chip">{Math.round(goal.brightness * 100)}% bright</span>
        {goal.deadline && <span className="chip"><Calendar /> {formatDeadline(goal.deadline)}</span>}
        {focusing && <span className="chip chip-live">Focusing</span>}
      </div>

      <div className="gp-body" aria-hidden={collapsed}>
        <div className="gp-inner">
          <div className="gp-scroll">
            <div className="seg seg-small gp-tabs" role="tablist" aria-label="Goal sections">
              {little
                ? <button role="tab" aria-selected={tab === 'plan'} className={tab === 'plan' ? 'is-active' : ''} onClick={() => setTab('plan')}>Plan</button>
                : <button role="tab" aria-selected={tab === 'track'} className={tab === 'track' ? 'is-active' : ''} onClick={() => setTab('track')}>Track</button>}
              <button role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'is-active' : ''} onClick={() => setTab('about')}>About</button>
            </div>

            {tab === 'plan' && (
              <div className="gp-section" role="tabpanel">
                <h3 className="gp-label">Milestones</h3>
                {ms.length > 0
                  ? <MilestoneTimeline milestones={ms} onToggle={onToggle} />
                  : <AddRow label={PROMPTS.steps.label} onClick={() => onAsk(PROMPTS.steps.ask)} />}

                <h3 className="gp-label">Sub-goals <span className="gp-hint">results on the way</span></h3>
                {subgoals.length > 0 ? (
                  <ul className="subgoals">
                    {subgoals.map(d => <li key={d.id} className="subgoal"><span className="subgoal-mark" aria-hidden />{d.text}</li>)}
                  </ul>
                ) : <AddRow label={PROMPTS.subgoal.label} onClick={() => onAsk(PROMPTS.subgoal.ask)} />}

                <h3 className="gp-label">Actions <span className="gp-hint">doable in one sitting</span></h3>
                {actions.length > 0 ? (
                  <ul className="actions">
                    {actions.map(d => <li key={d.id} className="action"><span className="action-mark" aria-hidden>→</span>{d.text}</li>)}
                  </ul>
                ) : <AddRow label={PROMPTS.action.label} onClick={() => onAsk(PROMPTS.action.ask)} />}

                {sessions.length > 0 && (
                  <>
                    <h3 className="gp-label">Recent sessions</h3>
                    <ul className="sessions">
                      {sessions.map(s => (
                        <li key={s.id} className="session-row">
                          <span className="session-bar" aria-hidden>
                            <span style={{ width: `${Math.min(100, (s.verifiedSeconds / Math.max(60, s.plannedMinutes * 60)) * 100)}%` }} />
                          </span>
                          <span className="session-text">
                            <span className="session-head">{s.headline || s.task}</span>
                            <span className="session-meta mono">{Math.round(s.verifiedSeconds / 60)}/{s.plannedMinutes} min · {ago(s.endedAt)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {tab === 'track' && (
              <div className="gp-section" role="tabpanel">
                <PanelTrack goal={goal} dock={dock} track={track} onToggle={onToggle} onAsk={onAsk} />
              </div>
            )}

            {tab === 'about' && (
              <div className="gp-section" role="tabpanel">
                <h3 className="gp-label">Why it matters</h3>
                {goal.why ? <p className="gp-quote">“{goal.why}”</p> : <AddRow label={PROMPTS.why.label} onClick={() => onAsk(PROMPTS.why.ask)} />}

                <h3 className="gp-label">Success looks like</h3>
                {goal.successLooksLike
                  ? <p className="gp-text">{goal.successLooksLike}</p>
                  : <AddRow label={PROMPTS.success.label} onClick={() => onAsk(PROMPTS.success.ask)} />}

                {aboutGroups.map(g => (
                  <div key={g.kind}>
                    <h3 className="gp-label">{g.title}</h3>
                    <ul className={`known kind-${g.kind}`}>
                      {g.items.map(d => <li key={d.id} className="known-item">{d.text}</li>)}
                    </ul>
                  </div>
                ))}

                {aboutExtras.length > 0 && (
                  moreAbout
                    ? <div className="details">{aboutExtras.map(k => <AddRow key={k} label={PROMPTS[k].label} onClick={() => onAsk(PROMPTS[k].ask)} />)}</div>
                    : <button className="detail-more" onClick={() => setMoreAbout(true)}>More details…</button>
                )}

                <div className={`danger-zone ${confirmDelete ? 'is-confirming' : ''}`}>
                  {confirmDelete ? (
                    <>
                      <p className="danger-text">Delete “{goal.title}” with its milestones, details and sessions? This can’t be undone. Your verified focus time and points stay.</p>
                      <div className="dock-actions">
                        <button className="danger-btn" disabled={deleting}
                          onClick={async () => { setDeleting(true); try { await onDelete() } finally { setDeleting(false) } }}>
                          {deleting ? 'Deleting…' : 'Delete star'}
                        </button>
                        <button className="ghost ghost-quiet" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <button className="danger-link" onClick={() => setConfirmDelete(true)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                      </svg>
                      Delete this star
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {pinnedDock && <div className="gp-dock">{dock}</div>}
        </div>
      </div>
    </aside>
  )
}
