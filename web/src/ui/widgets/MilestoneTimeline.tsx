import { useState } from 'react'
import type { Milestone } from '../../types'
import { Spark } from '../icons'

/** Milestones as a little constellation: nodes joined by a line, lit when done (the v1 timeline). */
export function MilestoneTimeline({ milestones, onToggle }: { milestones: Milestone[]; onToggle: (milestoneId: string) => void | Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null)
  const ms = [...milestones].sort((a, b) => a.order - b.order)
  const nextId = ms.find(m => !m.done)?.id
  return (
    <ol className="timeline">
      {ms.map(m => (
        <li key={m.id} className={`tl-item ${m.done ? 'is-done' : ''} ${m.id === nextId ? 'is-next' : ''}`}>
          <button className="tl-btn" disabled={pending === m.id} title={m.done ? 'Mark as not done' : 'Mark as done'} aria-pressed={m.done}
            onClick={async () => { setPending(m.id); try { await onToggle(m.id) } finally { setPending(null) } }}>
            <span className="tl-node" aria-hidden><Spark size={10} /></span>
            <span className="tl-title">{m.title}</span>
            {m.id === nextId && <span className="milestone-next">next</span>}
          </button>
        </li>
      ))}
    </ol>
  )
}
