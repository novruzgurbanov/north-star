import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ChatMessage } from '../types'
import { MAX_SECONDS, Recorder, toPcm16k, voiceLevel } from '../voice'
import { ArrowUp, Check, Close, Mic } from './icons'

type Props = {
  messages: ChatMessage[]
  busy: boolean
  discovering: boolean
  understanding: number
  hasGoals: boolean
  goalTitle?: string
  onSend: (text: string) => void
  onError: (text: string) => void
  suggestions: string[]
  little?: boolean
}

type VoiceState = 'idle' | 'recording' | 'transcribing'

const STARTERS = ['Learn a new language', 'Get fit for a race', 'Ship my side project']

/** Scrolling bar waveform of the live microphone level. */
function Waveform({ recorder }: { recorder: Recorder }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const g = el.getContext('2d')!
    const history: number[] = []
    let raf = 0
    let last = 0
    const color = getComputedStyle(el).color
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      const level = recorder.level()
      voiceLevel.current += (level - voiceLevel.current) * 0.35
      if (t - last < 45) return
      last = t
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== w * dpr) { el.width = w * dpr; el.height = h * dpr }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const bars = Math.floor(w / 5)
      history.push(level)
      while (history.length > bars) history.shift()
      g.clearRect(0, 0, w, h)
      g.fillStyle = color
      for (let i = 0; i < history.length; i++) {
        const v = Math.max(0.06, Math.min(1, history[i] * 1.6))
        const bh = v * (h - 4)
        const x = w - (history.length - i) * 5
        g.globalAlpha = 0.35 + 0.65 * (i / history.length)
        g.beginPath()
        g.roundRect(x, (h - bh) / 2, 2.5, bh, 1.25)
        g.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [recorder])
  return <canvas ref={canvas} className="waveform" aria-hidden />
}

export function ChatDock({ messages, busy, discovering, hasGoals, goalTitle, onSend, onError, suggestions, little }: Props) {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState<VoiceState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [slow, setSlow] = useState(false)
  const recorder = useRef<Recorder | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const empty = messages.length === 0
  const starters = discovering && empty && suggestions.length === 0
  const chips = starters ? STARTERS : suggestions

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy])

  useEffect(() => {
    input.current?.focus()
  }, [discovering, goalTitle])

  // Auto-grow the textarea up to a few lines.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text, voice])

  // Recording timer, with a hard stop at the server's limit.
  useEffect(() => {
    if (voice !== 'recording') return
    const started = Date.now()
    setSeconds(0)
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      setSeconds(s)
      if (s >= MAX_SECONDS) void finishVoice(false)
    }, 250)
    return () => clearInterval(id)
  }, [voice]) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape cancels a recording.
  useEffect(() => {
    if (voice !== 'recording') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelVoice() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [voice])

  useEffect(() => () => recorder.current?.cancel(), [])

  // The strongest model can take a while; say so instead of leaving bare dots.
  useEffect(() => {
    if (!busy) { setSlow(false); return }
    const id = setTimeout(() => setSlow(true), 3500)
    return () => clearTimeout(id)
  }, [busy])

  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    onSend(value)
  }

  const startVoice = async () => {
    if (voice !== 'idle') return
    const rec = new Recorder()
    try {
      await rec.start()
      recorder.current = rec
      setVoice('recording')
    } catch {
      rec.cancel()
      onError('Microphone is blocked. Allow it in the browser to talk.')
    }
  }

  const cancelVoice = () => {
    recorder.current?.cancel()
    recorder.current = null
    setVoice('idle')
    input.current?.focus()
  }

  /** Stop recording and transcribe. `send` sends right away, otherwise the text lands in the box. */
  const finishVoice = async (send: boolean) => {
    const rec = recorder.current
    if (!rec) return
    recorder.current = null
    setVoice('transcribing')
    try {
      const blob = await rec.stop()
      const pcm = await toPcm16k(blob)
      if (pcm.length < 16000 * 0.4) throw new Error('too short')
      const { text: heard } = await api.transcribe(pcm)
      const value = heard.trim()
      if (!value) {
        onError('I didn’t catch that. Try again a little closer to the mic.')
      } else if (send && !busy) {
        onSend(text.trim() ? `${text.trim()} ${value}` : value)
        setText('')
      } else {
        setText(t => (t.trim() ? `${t.trim()} ${value}` : value))
      }
    } catch (e) {
      onError(String(e).includes('too short') ? 'That was very short. Hold on a moment longer.' : 'Could not transcribe. Is the server running?')
    } finally {
      setVoice('idle')
      requestAnimationFrame(() => input.current?.focus())
    }
  }

  const placeholder = voice === 'transcribing'
    ? 'Listening back…'
    : discovering
      ? 'I want to…  (or tap the mic and just talk)'
      : little ? 'Add a detail, or tell me what you did today…' : `What did you do for “${goalTitle ?? 'your star'}” today?`

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <section className={`dock ${empty && discovering ? 'is-empty' : ''}`}>
      {discovering && empty && (
        <div className="hero">
          <h1 className="hero-title">{hasGoals ? 'What else do you want to reach?' : 'What do you want to reach?'}</h1>
          <p className="hero-sub">Write it in a few words, or just say it. Your star appears right away, and you can add details whenever you like.</p>
        </div>
      )}

      {!empty && (
        <div className="transcript" ref={scroller}>
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              {m.role === 'assistant' && <span className="msg-mark" aria-hidden />}
              <p>{m.content}</p>
            </div>
          ))}
          {busy && (
            <div className="msg msg-assistant">
              <span className="msg-mark" aria-hidden />
              <p className="typing" aria-label="North Star is thinking"><i /><i /><i />{slow && <span className="typing-note">thinking it through…</span>}</p>
            </div>
          )}
        </div>
      )}


      {!busy && voice === 'idle' && !text.trim() && chips.length > 0 && (
        <div className="suggestions" role="group" aria-label="Suggested answers">
          {chips.map((s, i) => (
            <button key={s} type="button" className={`suggestion ${i === 0 && !starters ? 'is-recommended' : ''}`} onClick={() => onSend(s)}
              title={i === 0 && !starters ? 'Recommended' : undefined}>
              {i === 0 && !starters && <span className="suggestion-mark" aria-label="Recommended">✦</span>}
              {s}
            </button>
          ))}
          <button type="button" className="suggestion is-other" onClick={() => input.current?.focus()}>Something else…</button>
        </div>
      )}

      <form className={`composer glass is-${voice}`} onSubmit={e => { e.preventDefault(); submit() }}>
        {voice === 'recording' && recorder.current ? (
          <>
            <button type="button" className="icon-btn" onClick={cancelVoice} aria-label="Cancel recording" title="Cancel (Esc)">
              <Close />
            </button>
            <span className="rec-dot" aria-hidden />
            <Waveform recorder={recorder.current} />
            <span className="rec-time mono">{clock}</span>
            <button type="button" className="icon-btn" onClick={() => void finishVoice(false)} aria-label="Stop and edit text" title="Stop, then edit before sending">
              <Check />
            </button>
            <button type="button" className="send" onClick={() => void finishVoice(true)} disabled={busy} aria-label="Stop and send" title="Stop and send">
              <ArrowUp />
            </button>
          </>
        ) : (
          <>
            <textarea
              ref={input}
              rows={1}
              value={text}
              placeholder={placeholder}
              disabled={voice === 'transcribing'}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            {voice === 'transcribing' ? (
              <span className="transcribing" aria-label="Transcribing"><i /><i /><i /></span>
            ) : (
              <button type="button" className="icon-btn mic" onClick={() => void startVoice()} aria-label="Talk instead of typing" title="Talk instead of typing">
                <Mic />
              </button>
            )}
            <button className="send" type="submit" disabled={!text.trim() || busy || voice !== 'idle'} aria-label="Send">
              <ArrowUp />
            </button>
          </>
        )}
      </form>
    </section>
  )
}
