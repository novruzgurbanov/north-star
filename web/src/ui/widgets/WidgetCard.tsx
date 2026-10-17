import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { More } from '../icons'

type MenuItem = { label: string; run: () => void; disabled?: boolean; danger?: boolean }

/** The small ⋯ menu on a widget card. Arrow keys move between items, Escape returns focus to the button. */
function WidgetMenu({ title, items }: { title: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()

  const enabled = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    enabled()[0]?.focus()
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const toggle = () => {
    if (open) return close(false)
    // Open upwards when the card sits near the bottom of the scrolling panel, so the menu isn't clipped.
    const scroller = button.current?.closest('.gp-scroll')
    const b = button.current?.getBoundingClientRect()
    const s = scroller?.getBoundingClientRect()
    setUp(!!b && !!s && b.bottom + 140 > s.bottom && b.top - 140 > s.top)
    setOpen(true)
  }

  const onKey = (e: KeyboardEvent) => {
    const list = enabled()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      list[(at + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <div className="wmenu-wrap">
      <button ref={button} className="wmenu-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={`Options for ${title}`} title="Options"
        onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); toggle() } }}>
        <More size={15} />
      </button>
      {open && (
        <div ref={menu} id={id} className={`wmenu ${up ? 'is-up' : ''}`} role="menu" aria-label={`${title} options`} onKeyDown={onKey}>
          {items.map(item => (
            <button key={item.label} role="menuitem" tabIndex={-1} className={`wmenu-item ${item.danger ? 'is-danger' : ''}`} disabled={item.disabled}
              onClick={() => { close(true); item.run() }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Props = {
  title: string
  type: string
  index: number
  count: number
  /** Without handlers (the local fallback panel) the card has no menu. */
  onMove?: (to: number) => void
  onRemove?: () => void
  children: ReactNode
}

/** A widget as a glass card: its title, the ⋯ menu, and the widget itself. Cards materialize one after another. */
export function WidgetCard({ title, type, index, count, onMove, onRemove, children }: Props) {
  const items: MenuItem[] = onMove && onRemove ? [
    { label: 'Move up', run: () => onMove(index - 1), disabled: index === 0 },
    { label: 'Move down', run: () => onMove(index + 1), disabled: index === count - 1 },
    { label: 'Remove', run: onRemove, disabled: count <= 1, danger: true },
  ] : []
  return (
    <section className={`wcard w-${type}`} aria-label={title} style={{ '--i': index } as CSSProperties}>
      <header className="wcard-head">
        <h3 className="wcard-title">{title}</h3>
        {items.length > 0 && <WidgetMenu title={title} items={items} />}
      </header>
      {children}
    </section>
  )
}
