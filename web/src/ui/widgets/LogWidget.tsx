import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError } from '../../api'
import type { Entry, EntryValues, Field, WidgetOf } from '../../types'
import { Camera, Close, Picture, Spark, Trash } from '../icons'
import { CameraSheet } from './CameraSheet'
import { ago, describeValues, valueAt } from './data'
import { base64Of, fileToJpeg } from './image'

type Draft = Record<string, string | number | boolean | undefined>

type Props = {
  w: WidgetOf<'log'>
  entries: Entry[]
  onLog: (values: EntryValues, proof?: string) => Promise<Entry>
  onDelete: (entryId: string) => Promise<void>
}

const PROOF_TONE = { verified: 'Verified', none: 'Self-reported', unverified: 'Not verified', rejected: 'Not verified' } as const

// A habit log with a single yes/no ("Done") starts on yes, so logging it is one tap.
const initialDraft = (fields: Field[]): Draft =>
  fields.length === 1 && fields[0].kind === 'boolean' ? { [fields[0].key]: true } : {}

/** 1-5 rating as small sparks, a radio group: arrow keys move the value, like a native radio set. */
function Rating({ id, value, onChange }: { id: string; value: number | undefined; onChange: (v: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (!step) return
    e.preventDefault()
    // Step from the focused spark (not the last rendered value), so quick key repeats never skip.
    const at = refs.current.indexOf(document.activeElement as HTMLButtonElement)
    const next = Math.min(5, Math.max(1, (at >= 0 ? at + 1 : value ?? 0) + step))
    onChange(next)
    refs.current[next - 1]?.focus()
  }
  return (
    <div className="lf-rating" role="radiogroup" aria-labelledby={id} onKeyDown={onKey}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} ref={el => { refs.current[n - 1] = el }} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of 5`}
          tabIndex={value === n || (!value && n === 1) ? 0 : -1}
          className={value !== undefined && n <= value ? 'is-on' : ''} onClick={() => onChange(n)}>
          <Spark size={17} />
        </button>
      ))}
      <span className="lf-rating-value mono" aria-hidden>{value ? `${value}/5` : ''}</span>
    </div>
  )
}

function YesNo({ id, value, onChange }: { id: string; value: boolean | undefined; onChange: (v: boolean) => void }) {
  const yes = useRef<HTMLButtonElement>(null)
  const no = useRef<HTMLButtonElement>(null)
  // Arrow keys flip the answer, like a native radio pair.
  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = !(document.activeElement === yes.current)
    onChange(next)
    ;(next ? yes : no).current?.focus()
  }
  return (
    <div className="seg seg-small lf-yesno" role="radiogroup" aria-labelledby={id} onKeyDown={onKey}>
      <button ref={yes} type="button" role="radio" aria-checked={value === true} tabIndex={value === false ? -1 : 0}
        className={value === true ? 'is-active' : ''} onClick={() => onChange(true)}>Yes</button>
      <button ref={no} type="button" role="radio" aria-checked={value === false} tabIndex={value === false ? 0 : -1}
        className={value === false ? 'is-active' : ''} onClick={() => onChange(false)}>No</button>
    </div>
  )
}

/** Returns the values to send, or the first problem to show (and which field it is in). */
function collect(fields: Field[], draft: Draft): { values: EntryValues } | { error: string; key: string } {
  const values: EntryValues = {}
  for (const f of fields) {
    const v = valueAt(draft, f.key)
    const empty = v === undefined || v === ''
    if (empty) {
      if (f.required) return { error: `Add ${f.label.toLowerCase()} first.`, key: f.key }
      continue
    }
    if (f.kind === 'number' || f.kind === 'minutes') {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: `${f.label} should be a number from 0 to 100,000.`, key: f.key }
      values[f.key] = f.kind === 'minutes' ? Math.round(n) : n
    } else if (f.kind === 'text') {
      const t = String(v).trim().slice(0, 120)
      if (!t) { if (f.required) return { error: `Add ${f.label.toLowerCase()} first.`, key: f.key }; continue }
      values[f.key] = t
    } else {
      values[f.key] = v as number | boolean
    }
  }
  // An empty entry would still show up as a session; the coach drops empty ones from chat too.
  if (Object.keys(values).length === 0) return { error: 'Fill in at least one field first.', key: fields[0]?.key ?? '' }
  return { values }
}

/** A compact form built from the log's fields, an optional photo or screenshot as proof, and the latest entries. */
export function LogWidget({ w, entries, onLog, onDelete }: Props) {
  const uid = useId()
  const [draft, setDraft] = useState<Draft>(() => initialDraft(w.fields))
  const [proof, setProof] = useState<string | null>(null)
  const [camera, setCamera] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Entry | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const photoBtn = useRef<HTMLButtonElement>(null)
  const submitBtn = useRef<HTMLButtonElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!confirming) return
    const id = setTimeout(() => setConfirming(null), 4000)
    return () => clearTimeout(id)
  }, [confirming])

  const set = (key: string, v: Draft[string]) => { setDraft(d => ({ ...d, [key]: v })); setError('') }
  const numeric = w.fields.filter(f => f.kind === 'number' || f.kind === 'minutes').length
  const recent = entries.slice(0, 3)

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { setError('Choose an image file.'); return }
    try { setProof(await fileToJpeg(f)); setError('') } catch { setError('That image could not be read. Try another one.') }
  }

  const submit = async () => {
    const out = collect(w.fields, draft)
    if ('error' in out) {
      setError(out.error)
      // Take the user straight to the field that needs them (the input, or the first choice of a group).
      const field = document.getElementById(`${uid}-${out.key}`) ?? document.querySelector<HTMLElement>(`[aria-labelledby="${uid}-${out.key}-l"] [tabindex="0"]`)
      field?.focus()
      return
    }
    if (w.proof === 'required' && !proof) { setError('This log needs a photo or a screenshot.'); return }
    setBusy(true)
    setError('')
    try {
      const entry = await onLog(out.values, proof ? base64Of(proof) : undefined)
      setResult(entry)
      setDraft(initialDraft(w.fields))
      setProof(null)
    } catch (err) {
      // A 400 means the server found something to fix in the form; say what. Anything else is worth a retry.
      setError(err instanceof ApiError && err.status === 400 ? `Could not log that: ${err.message}` : 'Could not log that. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="logw">
      <form className="lf" onSubmit={e => { e.preventDefault(); if (!busy) void submit() }} noValidate>
        <div className="lf-grid">
          {w.fields.map(f => {
            const id = `${uid}-${f.key}`
            const wide = f.kind === 'text' || f.kind === 'rating' || f.kind === 'boolean' || numeric === 1
            const v = valueAt(draft, f.key)
            const unit = f.kind === 'minutes' ? 'min' : f.unit ?? ''
            return (
              <div key={f.key} className={`lf-field ${wide ? 'is-wide' : ''}`}>
                <label className="lf-label" id={`${id}-l`} htmlFor={f.kind === 'rating' || f.kind === 'boolean' ? undefined : id}>
                  {f.label}
                </label>
                {(f.kind === 'number' || f.kind === 'minutes') && (
                  <div className="lf-num">
                    <input id={id} className="lf-input" type="number" inputMode={f.kind === 'minutes' ? 'numeric' : 'decimal'} min={0} max={100000}
                      step={f.kind === 'minutes' ? 1 : 'any'} value={typeof v === 'string' || typeof v === 'number' ? v : ''} required={f.required}
                      aria-describedby={unit ? `${id}-u` : undefined} onChange={e => set(f.key, e.target.value)}
                      style={{ paddingRight: unit ? 18 + unit.length * 7 : undefined }} />
                    {unit && <span className="lf-unit" id={`${id}-u`}>{unit}</span>}
                  </div>
                )}
                {f.kind === 'text' && (
                  <input id={id} className="lf-input" type="text" maxLength={120} value={typeof v === 'string' ? v : ''} required={f.required}
                    onChange={e => set(f.key, e.target.value)} />
                )}
                {f.kind === 'rating' && <Rating id={`${id}-l`} value={typeof v === 'number' ? v : undefined} onChange={n => set(f.key, n)} />}
                {f.kind === 'boolean' && <YesNo id={`${id}-l`} value={typeof v === 'boolean' ? v : undefined} onChange={b => set(f.key, b)} />}
              </div>
            )
          })}
        </div>

        {w.proof !== 'none' && (
          <div className="proof">
            <div className="lf-label">Proof {w.proof === 'optional' && <span className="gp-hint">optional</span>}</div>
            {w.proofHint && <p className="proof-hint">{w.proofHint}</p>}
            {proof ? (
              <div className="proof-picked">
                <img src={proof} alt="Your proof, ready to send" className="proof-thumb" />
                <span className="proof-note">Checked once by the AI, never stored.</span>
                <button type="button" className="wmenu-btn" onClick={() => setProof(null)} aria-label="Remove this photo"><Close size={12} /></button>
              </div>
            ) : (
              <div className="proof-row">
                <button ref={photoBtn} type="button" className="proof-btn" onClick={() => setCamera(true)}><Camera /> Take photo</button>
                <button type="button" className="proof-btn" onClick={() => file.current?.click()}><Picture /> Upload screenshot</button>
                <input ref={file} type="file" accept="image/*" hidden tabIndex={-1}
                  onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = '' }} />
              </div>
            )}
          </div>
        )}

        {error && <p className="lf-error" role="alert">{error}</p>}
        <button ref={submitBtn} type="submit" className="focus-start lf-submit" disabled={busy || (w.proof === 'required' && !proof)}>
          {busy ? (proof ? 'Checking your proof…' : 'Logging…') : <><Spark size={13} /> Log it</>}
        </button>
      </form>

      <div aria-live="polite">
        {result && (
          <div className={`result-chip tone-${result.proof}`}>
            <span className="result-dot" aria-hidden />
            <span className="result-text">
              <span className="result-label">{PROOF_TONE[result.proof]}</span>
              {(result.proof === 'unverified' || result.proof === 'rejected') && result.proofReason && <span className="result-reason">{result.proofReason}</span>}
              {result.proof === 'verified' && result.minutes > 0 && <span className="result-reason">These {result.minutes} minutes count toward your star.</span>}
              {result.proof === 'none' && w.proof !== 'none' && <span className="result-reason">It counts on this panel. Add a photo next time to verify it.</span>}
            </span>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <ul className="entries" aria-label="Latest entries">
          {recent.map(e => (
            <li key={e.id} className={`entry ${deleting === e.id ? 'is-leaving' : ''}`}>
              <span className={`entry-dot tone-${e.proof}`} title={PROOF_TONE[e.proof]} aria-hidden />
              <span className="entry-text">
                <span className="entry-values">{describeValues(w.fields, e.values) || 'Logged'}</span>
                <span className="entry-meta mono">{ago(e.at)} · {PROOF_TONE[e.proof].toLowerCase()}</span>
              </span>
              <button className={`entry-del ${confirming === e.id ? 'is-confirming' : ''}`} disabled={deleting === e.id}
                aria-label={confirming === e.id ? 'Confirm delete' : `Delete entry from ${ago(e.at)}`}
                onClick={async () => {
                  if (confirming !== e.id) { setConfirming(e.id); return }
                  setConfirming(null)
                  setDeleting(e.id)
                  try { await onDelete(e.id) } finally { setDeleting(null) }
                  if (result?.id === e.id) setResult(null)
                }}>
                {confirming === e.id ? 'Delete' : <Trash />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {camera && (
        <CameraSheet hint={w.proofHint}
          onCapture={url => { setProof(url); setCamera(false); setError(''); requestAnimationFrame(() => submitBtn.current?.focus()) }}
          onClose={() => { setCamera(false); requestAnimationFrame(() => photoBtn.current?.focus()) }} />
      )}
    </div>
  )
}
