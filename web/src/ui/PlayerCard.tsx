import { useEffect } from 'react'
import type { PointsRow } from '../types'
import { Clock, Flame, Spark } from './icons'
import { formatHours } from './Panels'

const SOURCE: Record<string, string> = { 'north-star': 'North Star', 'goal-coach': 'Goal Coach' }

const since = (iso: string | null) => {
  if (!iso) return 'not yet'
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (m < 2) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/** Another player's star, opened from the Cosmos. Only what the points service shares is shown. */
export function PlayerCard({ player, you, onClose }: { player: PointsRow; you: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="player-card glass" style={{ ['--pc' as string]: player.color }} aria-label={`${player.name}'s star`}>
      <header className="pc-head">
        <span className={`pc-dot ${player.live ? 'is-live' : ''}`} aria-hidden />
        <div className="pc-titles">
          <div className="eyebrow">{you ? 'Your star' : `#${player.rank} in the cosmos`}</div>
          <h2 className="panel-title">{player.name}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <div className="pc-goal">
        <div className="gp-label">Working toward</div>
        {player.goalTitle ? <p className="gp-quote">“{player.goalTitle}”</p> : <p className="gp-text">They keep their goal private.</p>}
      </div>

      <div className="pc-stats">
        <div><span className="pc-num mono"><Spark size={12} /> {player.points.toLocaleString()}</span><span className="pc-cap">points</span></div>
        <div><span className="pc-num mono"><Clock /> {formatHours(player.todayMinutes)}</span><span className="pc-cap">today</span></div>
        <div><span className="pc-num mono"><Flame /> {player.streak}</span><span className="pc-cap">day streak</span></div>
      </div>

      <p className="pc-foot">
        {player.live ? <span className="pc-live">Focusing right now</span> : <>Last focused {since(player.lastActiveAt)}</>}
        {' · '}{formatHours(player.focusedMinutes)} verified in total
        {player.sources.length > 0 && <> · via {player.sources.map(s => SOURCE[s] ?? s).join(' & ')}</>}
      </p>
    </aside>
  )
}
