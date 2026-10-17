import type { NextStep, WidgetOf } from '../../types'
import { Check } from '../icons'
import { daysUntil } from './data'

export function ChecklistWidget({ w, onToggle }: { w: WidgetOf<'checklist'>; onToggle?: (itemId: string) => void }) {
  const done = w.items.filter(i => i.done).length
  return (
    <div className="checklist">
      <ul className="cl-list">
        {w.items.map(item => (
          <li key={item.id}>
            <button className={`cl-item ${item.done ? 'is-done' : ''}`} role="checkbox" aria-checked={item.done}
              disabled={!onToggle} onClick={() => onToggle?.(item.id)}>
              <span className="cl-box" aria-hidden>{item.done && <Check size={11} />}</span>
              <span className="cl-text">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="w-caption">{done === w.items.length ? 'All done' : `${done} of ${w.items.length} done`}</div>
    </div>
  )
}

export function CountdownWidget({ w }: { w: WidgetOf<'countdown'> }) {
  const days = daysUntil(w.date)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(w.date)
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  const dateText = date ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : w.date
  return (
    <div className="countdown">
      <div className="w-big">
        {days === null ? <span className="w-unit">{w.date}</span>
          : days === 0 ? <span className="w-num">Today</span>
          : <><span className="w-num">{Math.abs(days)}</span><span className="w-unit">{Math.abs(days) === 1 ? 'day' : 'days'} {days > 0 ? 'to go' : 'ago'}</span></>}
      </div>
      <div className="w-caption">{w.label ? `${w.label} · ` : ''}<span className="mono">{dateText}</span></div>
    </div>
  )
}

export function NoteWidget({ w }: { w: WidgetOf<'note'> }) {
  return <p className="w-note">{w.text}</p>
}

/** The coach's one next task and why, without a start button (for goals worked on away from the screen). */
export function NextStepWidget({ next, onRefresh }: { next: NextStep | 'loading' | null; onRefresh: () => void }) {
  const step = next && next !== 'loading' ? next : null
  return (
    <div className="nextstep" aria-live="polite">
      {step ? (
        <>
          <p className="ns-task">{step.task}</p>
          {step.why && <p className="dockcard-why ns-why">{step.why}</p>}
        </>
      ) : (
        <p className="dockcard-text">{next === 'loading' ? <span className="typing" aria-label="Finding your next step"><i /><i /><i /></span> : 'No suggestion yet.'}</p>
      )}
      <div className="ns-foot">
        {step ? <span className="chip mono">about {step.minutes} min</span> : <span />}
        <button className="link-btn" onClick={onRefresh} disabled={next === 'loading'}>
          {next === 'loading' ? 'Thinking…' : step ? 'Suggest another' : 'Suggest one'}
        </button>
      </div>
    </div>
  )
}
