import { useEffect, useState, type ReactNode } from 'react'
import type { DetailKind, Goal, GoalDetail } from '../types'
import { Calendar, Plus, Spark } from './icons'

type Tab = 'plan' | 'about' | 'focus'

type Props = {
  goal: Goal
  color: string
  focus: ReactNode
  focusing: boolean
  onToggle: (milestoneId: string) => void
  onAsk: (text: string) => void
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
  if (parsed && !isNaN(parsed.getTime())) return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return d
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="detail-add" onClick={onClick}>
      <Plus size={12} /> {label}
    </button>
  )
}

function readCollapsed() {
  try { return localStorage.getItem('ns.panelCollapsed') === '1' } catch { return false }
}

export function GoalPanel({ goal, color, focus, focusing, onToggle, onAsk }: Props) {
  const little = goal.status === 'brainstorm'
  const [tab, setTab] = useState<Tab>(little ? 'about' : 'plan')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [pending, setPending] = useState<string | null>(null)
  const [moreAbout, setMoreAbout] = useState(false)

  useEffect(() => {
    try { localStorage.setItem('ns.panelCollapsed', collapsed ? '1' : '0') } catch { /* storage unavailable */ }
  }, [collapsed])

  const ms = [...goal.milestones].sort((a, b) => a.order - b.order)
  const done = ms.filter(m => m.done).length
  const nextId = ms.find(m => !m.done)?.id
  const details = goal.details ?? []
  const of = (kind: DetailKind): GoalDetail[] => details.filter(d => d.kind === kind)
  // The agent sometimes files one result as both a milestone and a sub-goal; show it once, as the milestone.
  const milestoneTitles = new Set(ms.map(m => m.title.trim().toLowerCase()))
  const subgoals = of('subgoal').filter(d => !milestoneTitles.has(d.text.trim().toLowerCase()))
  const actions = of('action')
  const missing = goal.missing ?? []

  const aboutGroups = ABOUT_GROUPS
    .map(g => ({ ...g, items: of(g.kind).filter(d => !(d.kind === 'motivation' && d.text === goal.why)) }))
    .filter(g => g.items.length > 0)
  const aboutExtras = (['distraction', 'on_track', 'obstacle'] as const).filter(k => of(k).length === 0)

  return (
    <aside className={`panel glass goal-panel ${collapsed ? 'is-collapsed' : ''}`} style={{ ['--star' as string]: color }}>
      <header className="gp-head">
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
        {ms.length > 0 && <span className="chip"><Spark size={11} /> {done}/{ms.length} lit</span>}
        <span className="chip">{Math.round(goal.brightness * 100)}% bright</span>
        {goal.deadline && <span className="chip"><Calendar /> {formatDeadline(goal.deadline)}</span>}
        {focusing && <span className="chip chip-live">Focusing</span>}
      </div>

      <div className="gp-body" aria-hidden={collapsed}>
        <div className="gp-inner">
          <div className="seg seg-small gp-tabs" role="tablist" aria-label="Goal sections">
            {(['plan', 'about', 'focus'] as Tab[]).map(t => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
                {t === 'plan' ? 'Plan' : t === 'about' ? 'About' : 'Focus'}
                {t === 'focus' && focusing && <span className="tab-dot" aria-hidden />}
              </button>
            ))}
          </div>

          {tab === 'plan' && (
            <div className="gp-section" role="tabpanel">
              <h3 className="gp-label">Milestones</h3>
              {ms.length > 0 ? (
                <>
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${(done / ms.length) * 100}%` }} /></div>
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
              ) : (
                <AddRow label={PROMPTS.steps.label} onClick={() => onAsk(PROMPTS.steps.ask)} />
              )}

              <h3 className="gp-label">Sub-goals <span className="gp-hint">results on the way</span></h3>
              {subgoals.length > 0 ? (
                <ul className="subgoals">
                  {subgoals.map(d => (
                    <li key={d.id} className="subgoal"><span className="subgoal-mark" aria-hidden />{d.text}</li>
                  ))}
                </ul>
              ) : <AddRow label={PROMPTS.subgoal.label} onClick={() => onAsk(PROMPTS.subgoal.ask)} />}

              <h3 className="gp-label">Actions <span className="gp-hint">doable in one sitting</span></h3>
              {actions.length > 0 ? (
                <ul className="actions">
                  {actions.map(d => (
                    <li key={d.id} className="action"><span className="action-mark" aria-hidden>→</span>{d.text}</li>
                  ))}
                </ul>
              ) : <AddRow label={PROMPTS.action.label} onClick={() => onAsk(PROMPTS.action.ask)} />}
            </div>
          )}

          {tab === 'about' && (
            <div className="gp-section" role="tabpanel">
              <h3 className="gp-label">Why it matters</h3>
              {goal.why
                ? <p className="gp-quote">“{goal.why}”</p>
                : <AddRow label={PROMPTS.why.label} onClick={() => onAsk(PROMPTS.why.ask)} />}

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
            </div>
          )}

          {tab === 'focus' && (
            <div className="gp-section" role="tabpanel">
              {little
                ? (
                  <div className="focus focus-web">
                    <p className="focus-note">This star needs {missing.includes('success') ? 'what success looks like' : ''}{missing.includes('success') && missing.includes('steps') ? ' and ' : ''}{missing.includes('steps') ? 'a first step' : ''} before focus sessions.</p>
                    {missing.includes('success') && <AddRow label={PROMPTS.success.label} onClick={() => onAsk(PROMPTS.success.ask)} />}
                    {missing.includes('steps') && <AddRow label={PROMPTS.steps.label} onClick={() => onAsk(PROMPTS.steps.ask)} />}
                  </div>
                )
                : focus}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
