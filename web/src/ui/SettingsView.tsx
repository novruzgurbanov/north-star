import type { ReactNode } from 'react'
import type { Settings } from '../types'

type Props = {
  settings: Settings
  saving: boolean
  desktop: boolean
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

// Check-interval stops: fine-grained at the low end, where it matters.
const CHECK_STOPS = [10, 15, 20, 30, 45, 60, 90, 120, 180, 300]
const fmtSeconds = (s: number) => (s < 60 ? `${s} s` : `${Math.round((s / 60) * 10) / 10} min`)

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
    </label>
  )
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        <div className="set-hint">{hint}</div>
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

const HELP_HINT: Record<Settings['helpfulness'], string> = {
  quiet: 'Short replies. It only asks when you ask for help.',
  balanced: 'Light questions, one at a time, when they help.',
  proactive: 'An engaged coach: proposes the next step every time.',
}
const STRICT_HINT: Record<Settings['strictness'], string> = {
  relaxed: 'Counts time generously; only flags obvious drifting.',
  normal: 'Counts time when it’s fairly sure you’re on task.',
  strict: 'Counts only clear focus, and flags drifting sooner.',
}
const ROAST_HINT: Record<Settings['roast'], string> = {
  off: 'Just a kind nudge when you drift.',
  mild: 'Gentle teasing about what you’re doing instead.',
  spicy: 'Sharper and more sarcastic. Still PG, never about you personally.',
}

export function SettingsView({ settings, saving, desktop, onChange, onClose }: Props) {
  const stopIndex = Math.max(0, CHECK_STOPS.findIndex(s => s >= settings.checkSeconds))
  return (
    <div className="page">
    <section className="settings glass" aria-label="Settings">
      <header className="settings-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h2 className="panel-title">How North Star works with you</h2>
        </div>
        <div className="settings-actions">
          <span className={`settings-saved ${saving ? 'is-saving' : ''}`}>{saving ? 'Saving…' : 'Saved'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </header>

      <div className="settings-group">
        <h3 className="settings-label">The agent</h3>
        <Row title="Helpfulness" hint={HELP_HINT[settings.helpfulness]}>
          <Segmented label="Helpfulness" value={settings.helpfulness} onChange={v => onChange({ helpfulness: v })}
            options={[{ value: 'quiet', label: 'Quiet' }, { value: 'balanced', label: 'Balanced' }, { value: 'proactive', label: 'Proactive' }]} />
        </Row>
        <Row title="Suggested answers" hint="Tappable replies under each message, the recommended one first.">
          <Toggle label="Suggested answers" checked={settings.suggestions} onChange={v => onChange({ suggestions: v })} />
        </Row>
      </div>

      <div className="settings-group">
        <h3 className="settings-label">Focus checks{!desktop && <span className="settings-note"> · run in the desktop app</span>}</h3>
        <Row title="Check every" hint="How often North Star glances at your screen while you focus.">
          <div className="range">
            <input type="range" min={0} max={CHECK_STOPS.length - 1} step={1} value={stopIndex}
              aria-label="Check interval" aria-valuetext={fmtSeconds(CHECK_STOPS[stopIndex])}
              onChange={e => onChange({ checkSeconds: CHECK_STOPS[Number(e.target.value)] })} />
            <span className="range-value mono">{fmtSeconds(CHECK_STOPS[stopIndex])}</span>
          </div>
        </Row>
        <Row title="Strictness" hint={STRICT_HINT[settings.strictness]}>
          <Segmented label="Strictness" value={settings.strictness} onChange={v => onChange({ strictness: v })}
            options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }]} />
        </Row>
        <Row title="Roasts" hint={ROAST_HINT[settings.roast]}>
          <Segmented label="Roasts" value={settings.roast} onChange={v => onChange({ roast: v })}
            options={[{ value: 'off', label: 'Off' }, { value: 'mild', label: 'Mild' }, { value: 'spicy', label: 'Spicy' }]} />
        </Row>
        <Row title="Notifications" hint="Windows notifications when you drift. Roasts always show in the app.">
          <Toggle label="Notifications" checked={settings.notifications} onChange={v => onChange({ notifications: v })} />
        </Row>
        <Row title="Use the camera by default" hint="Start focus sessions with the webcam on. Frames stay in memory, never saved.">
          <Toggle label="Camera by default" checked={settings.cameraByDefault} onChange={v => onChange({ cameraByDefault: v })} />
        </Row>
      </div>

      <div className="settings-group">
        <h3 className="settings-label">Interface and privacy</h3>
        <Row title="Sounds" hint="The chime when a star is born and the soft ding when one lights up.">
          <Toggle label="Sounds" checked={settings.sounds} onChange={v => onChange({ sounds: v })} />
        </Row>
        <Row title="Show my goal in the Cosmos" hint="Shares your goal’s title on the leaderboard. Points are always shared.">
          <Toggle label="Show my goal in the Cosmos" checked={settings.shareGoalTitle} onChange={v => onChange({ shareGoalTitle: v })} />
        </Row>
      </div>
    </section>
    </div>
  )
}
