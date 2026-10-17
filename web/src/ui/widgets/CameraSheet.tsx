import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Close } from '../icons'
import { toJpeg } from './image'

type Props = { hint: string; onCapture: (dataUrl: string) => void; onClose: () => void }

/**
 * A small glass sheet with a live webcam preview. The stream runs only while the sheet is open:
 * every track stops the moment the photo is taken or the sheet closes.
 */
export function CameraSheet({ hint, onCapture, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting')
  const titleId = useId()

  const stop = () => {
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
  }

  useEffect(() => {
    let cancelled = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      return
    }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' }, audio: false })
      .then(s => {
        // A late grant after the sheet closed must not leave the camera on.
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
        stream.current = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().catch(() => {})
        }
        // 'live' waits for the first frame (onLoadedData below): before it, there is nothing to take a photo of.
      })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true; stop() }
  }, [])

  // Focus starts on Close while the camera starts (or fails), and moves to Take photo once it is live,
  // unless the user has already tabbed somewhere else in the sheet.
  useEffect(() => {
    const box = sheet.current
    if (!box) return
    const close = box.querySelector<HTMLButtonElement>('.sheet-close')
    if (state !== 'live') { close?.focus(); return }
    const at = document.activeElement
    if (at === close || !box.contains(at)) box.querySelector<HTMLButtonElement>('.sheet-primary')?.focus()
  }, [state])

  const capture = () => {
    const v = video.current
    if (!v || !v.videoWidth || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    let url: string
    try { url = toJpeg(v, v.videoWidth, v.videoHeight) } catch { setState('error'); stop(); return }
    stop()
    onCapture(url)
  }

  const close = () => { stop(); onClose() }

  // Keep keyboard focus inside the sheet; Escape closes it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (e.key !== 'Tab') return
    const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  const host = (typeof document !== 'undefined' && (document.querySelector('.app') ?? document.body)) as HTMLElement
  return createPortal(
    <div className="sheet-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div ref={sheet} className="sheet glass" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
        <div className="sheet-head">
          <div className="dockcard-label" id={titleId}>Photo check-in</div>
          <button className="wmenu-btn sheet-close" onClick={close} aria-label="Close camera"><Close size={13} /></button>
        </div>
        <div className={`sheet-video is-${state}`}>
          <video ref={video} muted playsInline aria-label="Camera preview"
            onLoadedData={() => { if (stream.current) setState(s => (s === 'starting' ? 'live' : s)) }} />
          {state === 'starting' && <span className="sheet-status">Starting the camera…</span>}
          {state === 'error' && <span className="sheet-status">The camera isn’t available. You can upload a screenshot instead.</span>}
        </div>
        {hint && <p className="sheet-hint">{hint}</p>}
        <div className="dock-actions">
          <button className="focus-start sheet-primary" onClick={capture} disabled={state !== 'live'}>Take photo</button>
          <button className="ghost ghost-quiet" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>,
    host,
  )
}
