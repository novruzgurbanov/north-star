import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DetailKind, Entry, EntryValues, Goal, NextStep, Widget, WidgetOp } from '../types'
import { ArrowUp, Plus, Spark, Trash } from './icons'
import { ago, entriesOf, logWidget } from './widgets/data'
import { LogWidget, PROOF_TONE } from './widgets/LogWidget'
import { MilestoneTimeline } from './widgets/MilestoneTimeline'
import { ChecklistWidget, CountdownWidget, NextStepWidget, NoteWidget } from './widgets/SimpleWidgets'
import { ChartWidget, CounterWidget, HabitGridWidget, StreakWidget } from './widgets/StatWidgets'
import { WidgetCard } from './widgets/WidgetCard'

/** What App hands the Track tab: panel state plus the calls that change it. */
export type TrackHandlers = {
  /** 'working' while the AI designs this goal's first panel; 'failed' if that call failed */
  design: 'working' | 'failed' | null
  next: NextStep | 'loading' | null
  onRedesign: () => void
  /** Resolves true once the AI changed the panel (App shows the toast with Undo). */
  onEdit: (instruction: string) => Promise<boolean>
  /** False once the server said there is nothing to undo at this panel version. */
  canUndo: boolean
  onUndo: () => void
  onOp: (widgetId: string, op: WidgetOp) => void
  onLog: (widgetId: string, values: EntryValues, proof?: string) => Promise<Entry>
  onDeleteEntry: (entryId: string) => Promise<void>
  onRefreshNext: () => void
}

type Props = {
  goal: Goal
  dock: ReactNode
  track: TrackHandlers
  onToggle: (milestoneId: string) => void
  onAsk: (text: string) => void
}

// Shown when the first design failed, so the goal is still workable: the v1 plan as two plain cards.
const FALLBACK: Widget[] = [
  { id: 'fallback_ms', title: 'Milestones', type: 'milestones' },
  { id: 'fallback_focus', title: 'Focus', type: 'focus_session', minutes: [25, 50] },
]

function Designing({ title }: { title: string }) {
  return (
    <div className="designing" role="status" aria-live="polite">
      <p className="designing-label">Designing your panel…</p>
      <p className="designing-sub">Choosing what to track for “{title}”.</p>
      {[86, 128, 64].map((h, i) => <div key={i} className="skel shimmer" style={{ height: h, animationDelay: `${i * 120}ms` }} aria-hidden />)}
    </div>
  )
}

/**
 * "Change this panel…": an inline instruction for the AI editor. Below it, a lasting "Undo last change",
 * so undoing never depends on catching the toast in time.
 */
function ChangePanel({ onEdit, onBusy, onUndo }: {
  onEdit: (instruction: string) => Promise<boolean>; onBusy: (busy: boolean) => void; onUndo?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // The input opens at the very bottom of the scrolling panel; bring it (and the working shimmer) into view.
  useEffect(() => {
    if (!open) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    form.current?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }, [open, busy])

  const cancel = () => {
    setOpen(false)
    setText('')
    requestAnimationFrame(() => opener.current?.focus())
  }
  const submit = async () => {
    const instruction = text.trim().slice(0, 300)
    if (!instruction || busy) return
    setBusy(true)
    onBusy(true)
    let done = false
    try {
      done = await onEdit(instruction)
    } finally {
      setBusy(false)
      onBusy(false)
    }
    // Success closes the input; a failure (App already said so in a toast) keeps the words to try again.
    if (done) cancel()
    else requestAnimationFrame(() => input.current?.focus())
  }

  if (!open) {
    return (
      <>
        <button ref={opener} className="track-change" onClick={() => setOpen(true)}>
          <Spark size={12} /> Change this panel…
        </button>
        {onUndo && <button className="link-btn track-undo" onClick={onUndo}>Undo last change</button>}
      </>
    )
  }
  return (
    <form ref={form} className={`track-edit ${busy ? 'is-busy' : ''}`} onSubmit={e => { e.preventDefault(); void submit() }}
      onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); cancel() } }}>
      <div className="track-edit-row">
        <input ref={input} className="task-input" autoFocus value={text} maxLength={300} disabled={busy}
          placeholder="e.g. add a weekly km chart, 5 runs a week" aria-label="How should this panel change?"
          onChange={e => setText(e.target.value)} />
        <button type="submit" className="send track-send" disabled={!text.trim() || busy} aria-label="Change the panel"><ArrowUp size={15} /></button>
      </div>
      {busy
        ? <div className="track-working shimmer" role="status">Reworking your panel…</div>
        : <button type="button" className="link-btn track-cancel" onClick={cancel}>Cancel</button>}
    </form>
  )
}

// The log's field labels are gone with it, so an orphaned entry is summarized by its keys: "books finished: 1 · feeling: 4".
const orphanSummary = (e: Entry) =>
  Object.entries(e.values ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'yes' : v === false ? 'no' : String(v).slice(0, 40)}`).join(' · ')

/**
 * Entries of a log the panel no longer has: they belong to no widget, so they would otherwise be
 * invisible (and undeletable). One small card below the widgets, collapsed by default; deleting
 * goes through the same handler as the log's own list. Undo restoring the log rehomes them.
 */
function OrphanedEntries({ entries, onDelete }: { entries: Entry[]; onDelete: (entryId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  // An armed delete that is never confirmed steps back down after a moment (same as the log's list).
  useEffect(() => {
    if (!confirming) return
    const id = setTimeout(() => setConfirming(null), 4000)
    return () => clearTimeout(id)
  }, [confirming])

  return (
    <section className="wcard orphaned" aria-label="Entries from a removed log">
      <button className="orphaned-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="wcard-title">Entries from a removed log</span>
        <span className="gp-hint">{entries.length}{open ? ' · Hide' : ' · Show'}</span>
      </button>
      {open && (
        <ul className="entries">
          {entries.map(e => (
            <li key={e.id} className="entry">
              <span className={`entry-dot tone-${e.proof}`} title={PROOF_TONE[e.proof]} aria-hidden />
              <span className="entry-text">
                <span className="entry-values">{orphanSummary(e) || 'Logged'}</span>
                <span className="entry-meta mono">
                  {new Date(e.at).toLocaleDateString()}{e.minutes > 0 && ` · ${e.minutes} min`}
                </span>
              </span>
              <button className={`entry-del ${confirming === e.id ? 'is-confirming' : ''}`} disabled={deleting === e.id}
                aria-label={confirming === e.id ? 'Confirm delete' : `Delete entry from ${ago(e.at)}`}
                onClick={async () => {
                  if (confirming !== e.id) { setConfirming(e.id); return }
                  setConfirming(null)
                  setDeleting(e.id)
                  try { await onDelete(e.id) } finally { setDeleting(null) }
                }}>
                {confirming === e.id ? 'Delete' : <Trash />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The Track tab: the goal's AI-designed widgets, top to bottom. */
export function PanelTrack({ goal, dock, track, onToggle, onAsk }: Props) {
  const [reworking, setReworking] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = goal.panel ?? null
  const widgets = panel?.widgets ?? (track.design === 'failed' ? FALLBACK : null)

  if (!widgets) return <Designing title={goal.title} />

  const editable = !!panel
  const milestoneTitles = new Set(goal.milestones.map(m => m.title.trim().toLowerCase()))
  const of = (kind: DetailKind) => (goal.details ?? []).filter(d => d.kind === kind)
  const subgoals = of('subgoal').filter(d => !milestoneTitles.has(d.text.trim().toLowerCase()))
  const sessions = (goal.sessions ?? []).slice(0, 2)
  // Entries whose log widget is gone from the panel: kept and still deletable, in their own card below.
  const logIds = new Set(widgets.filter(w => w.type === 'log').map(w => w.id))
  const orphaned = (goal.entries ?? []).filter(e => !logIds.has(e.widgetId)).sort((a, b) => b.at.localeCompare(a.at))

  // Removing a card unmounts the ⋯ button that had focus. Hand focus to the card that took its place
  // (or the one above, for the last card) instead of letting it fall back to the page.
  const remove = (widgetId: string, index: number) => {
    track.onOp(widgetId, { kind: 'remove' })
    requestAnimationFrame(() => {
      const at = document.activeElement
      if (at && at !== document.body && at.isConnected) return
      const menus = list.current?.querySelectorAll<HTMLButtonElement>('.wcard-head .wmenu-btn')
      const next = menus?.length ? menus[Math.min(index, menus.length - 1)] : root.current?.querySelector<HTMLButtonElement>('.track-change')
      next?.focus()
    })
  }

  const body = (w: Widget) => {
    switch (w.type) {
      case 'milestones':
        return goal.milestones.length > 0 ? (
          <>
            <MilestoneTimeline milestones={goal.milestones} onToggle={onToggle} />
            {subgoals.length > 0 && (
              <ul className="subgoals w-subgoals" aria-label="Results on the way">
                {subgoals.map(d => <li key={d.id} className="subgoal"><span className="subgoal-mark" aria-hidden />{d.text}</li>)}
              </ul>
            )}
          </>
        ) : <button className="detail-add" onClick={() => onAsk('Let’s add the first steps.')}><Plus size={12} /> First steps</button>
      case 'focus_session':
        return (
          <>
            {dock}
            {sessions.length > 0 && (
              <ul className="sessions w-sessions" aria-label="Recent sessions">
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
            )}
          </>
        )
      case 'next_step':
        return <NextStepWidget next={track.next} onRefresh={track.onRefreshNext} />
      case 'log':
        return <LogWidget w={w} entries={entriesOf(goal, w.id)}
          onLog={(values, proof) => track.onLog(w.id, values, proof)} onDelete={track.onDeleteEntry} />
      case 'streak':
        return <StreakWidget w={w} entries={entriesOf(goal, w.source)} hasSource={!!logWidget(goal, w.source)} />
      case 'counter':
        return <CounterWidget w={w} entries={entriesOf(goal, w.source)} hasSource={!!logWidget(goal, w.source)} />
      case 'chart':
        return <ChartWidget w={w} entries={entriesOf(goal, w.source)} hasSource={!!logWidget(goal, w.source)} />
      case 'habit_grid':
        return <HabitGridWidget w={w} entries={entriesOf(goal, w.source)} hasSource={!!logWidget(goal, w.source)} />
      case 'checklist':
        return <ChecklistWidget w={w} onToggle={editable ? itemId => track.onOp(w.id, { kind: 'toggle_item', itemId }) : undefined} />
      case 'countdown':
        return <CountdownWidget w={w} />
      case 'note':
        return <NoteWidget w={w} />
      default:
        return null
    }
  }

  return (
    <div ref={root} className="track">
      {track.design === 'failed' && !panel && (
        <div className="track-retry">
          <p className="dockcard-text">Your panel couldn’t be designed just now, so here is the classic plan.</p>
          <button className="link-btn" onClick={track.onRedesign}>Try again</button>
        </div>
      )}
      {panel?.summary && <p className="track-summary">{panel.summary}</p>}

      {/* While the AI reworks the panel the cards are inert (no clicks, no keyboard): the editor saves over
          the spec it read at the start, so a tick or a move made meanwhile would be lost. */}
      <div ref={list} className={`track-widgets ${reworking ? 'is-reworking' : ''}`} aria-busy={reworking} inert={reworking}>
        {widgets.map((w, i) => (
          <WidgetCard key={w.id} title={w.title} type={w.type} index={i} count={widgets.length}
            onMove={editable ? to => track.onOp(w.id, { kind: 'move', to }) : undefined}
            onRemove={editable ? () => remove(w.id, i) : undefined}>
            {body(w)}
          </WidgetCard>
        ))}
        {orphaned.length > 0 && <OrphanedEntries entries={orphaned} onDelete={track.onDeleteEntry} />}
      </div>

      {editable && <ChangePanel onEdit={track.onEdit} onBusy={setReworking} onUndo={track.canUndo ? track.onUndo : undefined} />}
    </div>
  )
}
