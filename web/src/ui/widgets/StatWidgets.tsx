import type { Entry, WidgetOf } from '../../types'
import { addDays, dayKey, daysWithEntries, fmtNum, periodStart, periodTotals, streakStats, sumFor } from './data'

const Missing = () => <p className="w-empty">The log this widget reads from was removed.</p>

/** Current streak in periods, this period's progress as dots, and the best streak. */
export function StreakWidget({ w, entries, hasSource }: { w: WidgetOf<'streak'>; entries: Entry[]; hasSource: boolean }) {
  if (!hasSource) return <Missing />
  const s = streakStats(entries, w.cadence, w.perPeriod)
  const unit = w.cadence === 'daily' ? 'day' : 'week'
  const now = w.cadence === 'daily' ? 'today' : 'this week'
  const done = Math.min(s.thisPeriod, s.target)
  return (
    <div className="streak">
      <div className="w-big">
        <span className="w-num">{s.streak}</span>
        <span className="w-unit">{unit}{s.streak === 1 ? '' : 's'} in a row</span>
        <span className="w-side mono" title="Best streak">best {s.best}</span>
      </div>
      <div className="pdots-row">
        {s.target <= 14 && (
          <span className="pdots" aria-hidden>
            {Array.from({ length: s.target }, (_, i) => <i key={i} className={i < done ? 'is-on' : ''} />)}
          </span>
        )}
        <span className="w-caption">
          {s.thisPeriod >= s.target ? `Done ${now}` : `${s.thisPeriod} of ${s.target} ${now}`}
          {s.thisPeriod > s.target && <span className="mono"> · {s.thisPeriod}</span>}
        </span>
      </div>
    </div>
  )
}

function Ring({ progress, size = 56 }: { progress: number; size?: number }) {
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  const p = Math.min(1, Math.max(0, progress))
  return (
    <div className="ring w-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - p)} />
      </svg>
      <div className="ring-center"><span className="mono w-ring-pct">{Math.round(progress * 100)}%</span></div>
    </div>
  )
}

const PERIOD_LABEL = { week: 'this week', month: 'this month', total: 'in total' } as const

/** A running total of one field toward a target for the period. */
export function CounterWidget({ w, entries, hasSource }: { w: WidgetOf<'counter'>; entries: Entry[]; hasSource: boolean }) {
  if (!hasSource) return <Missing />
  const total = sumFor(entries, w.field, w.period)
  const progress = w.target > 0 ? total / w.target : 0
  return (
    <div className="counter">
      <div className="counter-text">
        <div className="w-big">
          <span className="w-num">{fmtNum(total)}</span>
          <span className="w-unit">{w.unit}</span>
        </div>
        <div className="w-caption">of {fmtNum(w.target)} {w.unit} {PERIOD_LABEL[w.period]}{progress >= 1 ? ' · reached' : ''}</div>
      </div>
      <Ring progress={progress} />
    </div>
  )
}

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const shortMonth = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })

/** Totals for the last `span` weeks or months as a pure-SVG bar chart; the current period is lit. */
export function ChartWidget({ w, entries, hasSource }: { w: WidgetOf<'chart'>; entries: Entry[]; hasSource: boolean }) {
  if (!hasSource) return <Missing />
  const bars = periodTotals(entries, w.field, w.period, w.span)
  const W = 272
  const H = 78
  const gap = bars.length > 8 ? 5 : 7
  const bw = (W - gap * (bars.length - 1)) / bars.length
  const max = Math.max(1, ...bars.map(b => b.total))
  const current = bars[bars.length - 1]
  const past = bars.slice(0, -1)
  const avg = past.length ? past.reduce((s, b) => s + b.total, 0) / past.length : 0
  const label = (d: Date) => (w.period === 'week' ? shortDate(d) : shortMonth(d))
  const summary = `${w.title}: ${bars.map(b => `${label(b.start)} ${fmtNum(b.total)} ${w.unit}`).join(', ')}`
  return (
    <div className="chart">
      <div className="chart-head">
        <span><span className="chart-now">{fmtNum(current.total)}</span> <span className="w-caption">{w.unit} {w.period === 'week' ? 'this week' : 'this month'}</span></span>
        {avg > 0 && <span className="w-side mono">avg {fmtNum(avg)}</span>}
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={summary}>
        <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} className="chart-base" />
        {bars.map((b, i) => {
          const h = b.total > 0 ? Math.max(3, (b.total / max) * (H - 6)) : 2
          const isNow = i === bars.length - 1
          return (
            <rect key={dayKey(b.start)} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(3, bw / 2)}
              className={`chart-bar ${isNow ? 'is-current' : ''} ${b.total > 0 ? '' : 'is-zero'}`}>
              <title>{`${label(b.start)}: ${fmtNum(b.total)} ${w.unit}`}</title>
            </rect>
          )
        })}
        <text x="0" y={H + 13} className="chart-label">{label(bars[0].start)}</text>
        <text x={W} y={H + 13} textAnchor="end" className="chart-label is-current">{w.period === 'week' ? 'This week' : 'This month'}</text>
      </svg>
    </div>
  )
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** One dot per day for the last 14 or 28 days, laid out Monday to Sunday; filled when something was logged. */
export function HabitGridWidget({ w, entries, hasSource }: { w: WidgetOf<'habit_grid'>; entries: Entry[]; hasSource: boolean }) {
  if (!hasSource) return <Missing />
  const today = periodStart(new Date(), 'day')
  const first = addDays(today, -(w.days - 1))
  const gridStart = periodStart(first, 'week')
  const gridEnd = addDays(periodStart(today, 'week'), 6)
  const filled = daysWithEntries(entries)
  const cells: { key: string; date: Date; state: 'out' | 'future' | 'on' | 'off'; today: boolean }[] = []
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    const key = dayKey(d)
    const state = d < first ? 'out' : d > today ? 'future' : filled.has(key) ? 'on' : 'off'
    cells.push({ key, date: d, state, today: key === dayKey(today) })
  }
  const count = cells.filter(c => c.state === 'on').length
  return (
    <div className="hgrid-wrap">
      <div className="hgrid" role="img" aria-label={`${count} of the last ${w.days} days logged`}>
        {WEEKDAYS.map((d, i) => <span key={`h${i}`} className="hgrid-day" aria-hidden>{d}</span>)}
        {cells.map(c => (
          <span key={c.key} className={`hcell is-${c.state} ${c.today ? 'is-today' : ''}`}
            title={c.state === 'out' ? undefined : `${c.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${c.state === 'on' ? ' · logged' : ''}`} />
        ))}
      </div>
      <div className="w-caption">{count} of the last {w.days} days</div>
    </div>
  )
}
