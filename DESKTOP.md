# North Star desktop bridge

The Windows desktop app (`desktop/`, Electron) opens the North Star web UI and runs focus verification in the Electron main process. The web UI detects the desktop shell through `window.northStarDesktop`, which is undefined in a normal browser.

```ts
type FocusStatus = 'idle' | 'active' | 'paused' | 'error'

type FocusCheck = {
  at: string                       // ISO time of the check
  verdict: 'on_track' | 'off_track' | 'uncertain'
  confidence: number
  reason: string
  nudge: string
  roast: string                    // playful one-liner about what they're doing, only when off_track
  counted: boolean
  countedSeconds: number
}

type FocusState = {
  status: FocusStatus
  userId: string | null
  goalId: string | null
  goalTitle: string | null
  startedAt: string | null
  nextCheckAt: string | null       // when the next snapshot will be taken
  checkSeconds: number             // interval between checks (default 20)
  sessionVerifiedSeconds: number   // verified on-task seconds in this session
  checks: number
  cameraEnabled: boolean           // the user's choice
  cameraActive: boolean            // the camera is actually streaming right now
  lastCheck: FocusCheck | null
  lastResult: { goal: unknown; stats: unknown; points: unknown } | null  // passthrough from POST /api/focus/check
  error: string | null             // human-readable, e.g. "Screen capture failed"
  notice: string | null            // non-fatal, e.g. "Windows is blocking North Star notifications."
}

interface NorthStarDesktop {
  isDesktop: true
  platform: string                 // process.platform
  focus: {
    start(opts: { userId: string; goalId: string; goalTitle: string; camera: boolean }): Promise<FocusState>
    pause(): Promise<FocusState>
    resume(): Promise<FocusState>
    stop(): Promise<FocusState>
    setCamera(enabled: boolean): Promise<FocusState>
    configure(opts: { checkSeconds?: number; notifications?: boolean }): Promise<FocusState>  // see SETTINGS.md
    getState(): Promise<FocusState>
    onState(listener: (state: FocusState) => void): () => void   // returns unsubscribe
  }
}

declare global { interface Window { northStarDesktop?: NorthStarDesktop } }
```

Focus loop (main process): every `checkSeconds` it captures the primary screen as a JPEG (and a webcam frame when the camera is enabled), posts them to the API's `POST /api/focus/check` with `sinceSeconds` (time since the previous check, paused time excluded), and pushes the new state. Every confident off-track check (confidence >= 0.7) shows a native notification with the roast (or the nudge), at most one per 20 s. If Windows blocks notifications, `notice` explains it. Images live only in memory.
