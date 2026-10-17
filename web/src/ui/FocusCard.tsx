import { useEffect, useState } from 'react'
import type { FocusState } from '../types'
import { Spark } from './icons'

type Props = {
  focus: FocusState | null
  goalId: string
  desktop: boolean
  camera: boolean
  onCamera: (enabled: boolean) => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [active])
  return now
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export function FocusCard({ focus, goalId, desktop, camera, onCamera, onStart, onPause, onResume, onStop }: Props) {
  const mine = focus && focus.goalId === goalId && focus.status !== 'idle' ? focus : null
  const now = useNow(!!mine && mine.status === 'active')

  if (!desktop) {
    return (
      <div className="focus focus-web">
        <div className="focus-head"><span className="eyebrow">Verified focus</span></div>
        <p className="focus-note">Focus checks run in the North Star desktop app. Verified minutes earn points on the shared leaderboard.</p>
      </div>
    )
  }

  if (!mine) {
    return (
      <div className="focus">
        <button className="focus-start" onClick={onStart}>
          <Spark size={13} /> Begin focus
        </button>
        <label className="switch">
          <input type="checkbox" checked={camera} onChange={e => onCamera(e.target.checked)} />
          <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
          Use the camera too
        </label>
        <p className="focus-note">Every 30 seconds North Star glances at your screen{camera ? ' and camera' : ''} to verify you’re on this star. Images stay in memory and are never saved.</p>
      </div>
    )
  }

  const check = mine.lastCheck
  const tone = mine.status !== 'active' ? 'idle' : !check ? 'waiting' : check.verdict
  const next = mine.nextCheckAt ? Math.max(0, (Date.parse(mine.nextCheckAt) - now) / 1000) : null
  const progress = next === null ? 0 : 1 - Math.min(1, next / Math.max(1, mine.checkSeconds))
  const label = mine.status === 'paused' ? 'Paused'
    : mine.status === 'error' ? 'Stopped checking'
    : !check ? 'Settling in'
    : check.verdict === 'on_track' ? 'On your star'
    : check.verdict === 'off_track' ? 'Drifting'
    : 'Not sure'

  return (
    <div className={`focus is-${mine.status}`}>
      <div className="focus-head">
        <span className={`focus-dot tone-${tone}`} aria-hidden />
        <span className="focus-label">{label}</span>
        <span className="focus-time mono" title="Verified this session">{clock(mine.sessionVerifiedSeconds)}</span>
      </div>

      {mine.status === 'error' && mine.error && <p className="focus-reason is-error">{mine.error}</p>}
      {mine.status !== 'error' && (
        check?.verdict === 'off_track' && check.roast
          ? <p className="focus-reason is-roast">“{check.roast}”</p>
          : <p className="focus-reason">
              {check ? (check.verdict === 'off_track' && check.nudge ? check.nudge : check.reason) : 'First glance in a few seconds.'}
            </p>
      )}
      {mine.notice && <p className="focus-note is-notice">{mine.notice}</p>}

      {mine.status === 'active' && next !== null && (
        <div className="focus-next">
          <span className="focus-next-track"><span style={{ width: `${progress * 100}%` }} /></span>
          <span className="mono">{next < 1 ? 'looking…' : `next in ${Math.ceil(next)}s`}</span>
        </div>
      )}

      <div className="focus-actions">
        {mine.status === 'active'
          ? <button className="ghost" onClick={onPause}>Pause</button>
          : <button className="ghost" onClick={onResume}>{mine.status === 'error' ? 'Try again' : 'Resume'}</button>}
        <button className="ghost" onClick={onStop}>End session</button>
      </div>
      <label className="switch">
        <input type="checkbox" checked={mine.cameraEnabled} onChange={e => onCamera(e.target.checked)} />
        <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
        Camera {mine.cameraEnabled ? (mine.cameraActive ? 'on' : 'starting…') : 'off'}
      </label>
    </div>
  )
}
