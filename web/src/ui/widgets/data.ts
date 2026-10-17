// Client-side numbers for the panel widgets. Everything is computed from goal.entries in local calendar
// time (a "day" is the user's day, weeks start on Monday), so the server only stores raw entries.
import type { Entry, EntryValues, Field, Goal, PanelSpec, Widget, WidgetOp, WidgetOf } from '../../types'

export type Period = 'day' | 'week' | 'month'

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
// new Date(y, m, d + n) stays on local midnight across daylight-saving changes, unlike adding 86 400 000 ms.
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export function periodStart(d: Date, p: Period) {
  if (p === 'month') return new Date(d.getFullYear(), d.getMonth(), 1)
  const day = startOfDay(d)
  return p === 'week' ? addDays(day, -((day.getDay() + 6) % 7)) : day
}
export function shiftPeriod(start: Date, p: Period, n: number) {
  if (p === 'month') return new Date(start.getFullYear(), start.getMonth() + n, 1)
  return addDays(start, p === 'week' ? 7 * n : n)
}

const when = (e: Entry) => {
  const t = new Date(e.at)
  return isNaN(t.getTime()) ? null : t
}

/** A log widget's entries, newest first. */
export function entriesOf(goal: Goal, widgetId: string): Entry[] {
  return (goal.entries ?? []).filter(e => e.widgetId === widgetId).sort((a, b) => b.at.localeCompare(a.at))
}

export function logWidget(goal: Goal, id: string): WidgetOf<'log'> | null {
  const w = goal.panel?.widgets.find(x => x.id === id)
  return w && w.type === 'log' ? w : null
}

/**
 * One value of an entry (or a form draft) by field key. Own keys only: a field the AI named "constructor"
 * must read as missing, not as Object.prototype.constructor.
 */
export const valueAt = <V>(values: Record<string, V>, key: string): V | undefined =>
  Object.hasOwn(values, key) ? values[key] : undefined

/**
 * Whether an entry records the activity happening: some yes, a number other than 0, a rating or some text.
 * A "No" check-in ("skipped today") stays in the log but doesn't light the habit grid or count toward a streak.
 */
export const recorded = (e: Entry) =>
  Object.values(e.values ?? {}).some(v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.trim() !== ''))

/** A numeric reading of one entry value; text and booleans count as 0. */
export function num(v: EntryValues[string] | undefined) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

function countByPeriod(entries: Entry[], p: Period) {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const t = when(e)
    if (!t) continue
    const k = dayKey(periodStart(t, p))
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

/**
 * Streak in periods where the target count was reached. The period in progress extends the streak once
 * it is met, but never breaks it while it is still open (a Monday morning keeps last week's streak).
 */
export function streakStats(all: Entry[], cadence: 'daily' | 'weekly', perPeriod: number, now = new Date()) {
  const p: Period = cadence === 'daily' ? 'day' : 'week'
  const target = Math.max(1, perPeriod)
  const entries = all.filter(recorded)
  const counts = countByPeriod(entries, p)
  const met = (s: Date) => (counts.get(dayKey(s)) ?? 0) >= target
  const current = periodStart(now, p)

  let streak = 0
  for (let s = met(current) ? current : shiftPeriod(current, p, -1); met(s); s = shiftPeriod(s, p, -1)) streak++

  let best = 0
  let run = 0
  const times = entries.map(when).filter((t): t is Date => !!t)
  if (times.length) {
    const first = periodStart(new Date(Math.min(...times.map(t => t.getTime()))), p)
    for (let s = first; s <= current; s = shiftPeriod(s, p, 1)) {
      run = met(s) ? run + 1 : 0
      best = Math.max(best, run)
    }
  }
  return { streak, best: Math.max(best, streak), thisPeriod: counts.get(dayKey(current)) ?? 0, target }
}

/** Sum of one numeric field in the current week or month, or over all entries. */
export function sumFor(entries: Entry[], field: string, period: 'week' | 'month' | 'total', now = new Date()) {
  if (period === 'total') return entries.reduce((s, e) => s + num(valueAt(e.values, field)), 0)
  const start = periodStart(now, period)
  const end = shiftPeriod(start, period, 1)
  return entries.reduce((s, e) => {
    const t = when(e)
    return t && t >= start && t < end ? s + num(valueAt(e.values, field)) : s
  }, 0)
}

/** Totals of one field for the last `span` weeks or months, oldest first; the last one is the current period. */
export function periodTotals(entries: Entry[], field: string, period: 'week' | 'month', span: number, now = new Date()) {
  const current = periodStart(now, period)
  const bars = Array.from({ length: Math.max(1, span) }, (_, i) => ({ start: shiftPeriod(current, period, i - span + 1), total: 0 }))
  const index = new Map(bars.map((b, i) => [dayKey(b.start), i]))
  for (const e of entries) {
    const t = when(e)
    const i = t ? index.get(dayKey(periodStart(t, period))) : undefined
    if (i !== undefined) bars[i].total += num(valueAt(e.values, field))
  }
  return bars
}

/** The days (local dayKey) with at least one entry that records the activity. */
export function daysWithEntries(entries: Entry[]) {
  const days = new Set<string>()
  for (const e of entries) {
    const t = recorded(e) ? when(e) : null
    if (t) days.add(dayKey(t))
  }
  return days
}

/** Whole days from today to a YYYY-MM-DD date (negative once it has passed). */
export function daysUntil(date: string, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round((target.getTime() - startOfDay(now).getTime()) / 86_400_000)
}

export const fmtNum = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 1 })

export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/** One line for an entry: "6 km · 35 min · 4/5", in the log's field order. */
export function describeValues(fields: Field[], values: EntryValues) {
  const parts: string[] = []
  for (const f of fields) {
    const v = valueAt(values, f.key)
    if (v === undefined || v === '') continue
    if (f.kind === 'number') parts.push(`${fmtNum(num(v))}${f.unit ? ` ${f.unit}` : ''}`)
    else if (f.kind === 'minutes') parts.push(`${fmtNum(num(v))} min`)
    else if (f.kind === 'rating') parts.push(`${f.label} ${num(v)}/5`)
    else if (f.kind === 'boolean') parts.push(v === true ? f.label : `${f.label}: no`)
    else parts.push(`“${String(v).slice(0, 40)}${String(v).length > 40 ? '…' : ''}”`)
  }
  return parts.join(' · ')
}

/** The same edit the server makes for a manual op, so the panel can change on screen right away. */
export function applyWidgetOp(panel: PanelSpec, widgetId: string, op: WidgetOp): PanelSpec {
  const widgets: Widget[] = [...panel.widgets]
  const i = widgets.findIndex(w => w.id === widgetId)
  if (i < 0) return panel
  if (op.kind === 'remove') widgets.splice(i, 1)
  else if (op.kind === 'move') {
    const [w] = widgets.splice(i, 1)
    widgets.splice(Math.max(0, Math.min(widgets.length, op.to)), 0, w)
  } else {
    const w = widgets[i]
    if (w.type === 'checklist') widgets[i] = { ...w, items: w.items.map(it => (it.id === op.itemId ? { ...it, done: !it.done } : it)) }
  }
  return { ...panel, widgets }
}
