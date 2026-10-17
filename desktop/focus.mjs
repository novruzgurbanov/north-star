const FIRST_CHECK_MS = 5_000;

function normalizeRoast(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 200) : '';
}

function notificationBody({ roast, nudge }, goalTitle) {
  if (roast) return roast;
  if (nudge.trim().length > 0) return nudge;
  return `Your star is waiting. Back to ${goalTitle}?`;
}

export function validStart(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && ['userId', 'goalId', 'goalTitle'].every((key) =>
      typeof value[key] === 'string' && value[key].trim().length > 0
      && value[key].length <= (key === 'goalTitle' ? 500 : 200))
    && typeof value.camera === 'boolean';
}

function validatedResult(result) {
  if (!result || !['on_track', 'off_track', 'uncertain'].includes(result.verdict)
    || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1
    || typeof result.reason !== 'string' || result.reason.length > 2_000
    || typeof result.nudge !== 'string' || result.nudge.length > 2_000
    || typeof result.counted !== 'boolean' || !Number.isFinite(result.countedSeconds)
    || result.countedSeconds < 0 || result.countedSeconds > 900
    || (!result.counted && result.countedSeconds !== 0)) {
    throw new Error('Invalid focus response');
  }
  return result;
}

// All clocks, captures, network calls, and side effects are injected for node:test.
export class FocusController {
  constructor({ checkSeconds = 20, notifyCooldownSeconds = 20, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, captureScreen,
    captureCamera = async () => null, setCamera = async () => false, check,
    onState = () => {}, notify = () => {}, log = () => {} }) {
    this.deps = { now, setTimer, clearTimer, captureScreen, captureCamera,
      setCamera, check, onState, notify, log };
    this.state = {
      status: 'idle', userId: null, goalId: null, goalTitle: null,
      startedAt: null, nextCheckAt: null,
      checkSeconds: Number.isFinite(checkSeconds) ? Math.max(10, checkSeconds) : 20,
      sessionVerifiedSeconds: 0, checks: 0, cameraEnabled: false,
      cameraActive: false, lastCheck: null, lastResult: null, error: null,
      notice: null,
    };
    this.notifyCooldownMs = (Number.isFinite(notifyCooldownSeconds)
      ? Math.max(5, notifyCooldownSeconds) : 20) * 1_000;
    this.timer = null;
    this.generation = 0;
    this.cameraGeneration = 0;
    this.inFlight = false;
    this.waiting = false;
    this.failures = 0;
    this.lastNotificationAt = -Infinity;
    this.previousAt = null;
    this.abort = null;
  }

  getState() { return structuredClone(this.state); }
  emit() { this.deps.onState(this.getState()); }

  setNotice(notice) {
    const next = typeof notice === 'string' && notice.trim().length > 0 ? notice : null;
    if (this.state.notice === next) return this.getState();
    this.state.notice = next;
    this.emit();
    return this.getState();
  }

  invalidate() {
    this.generation += 1;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.waiting = false;
    this.state.nextCheckAt = null;
    this.abort?.abort();
  }

  syncCamera() {
    const revision = ++this.cameraGeneration;
    const enabled = this.state.status === 'active' && this.state.cameraEnabled;
    if (!enabled) this.state.cameraActive = false;
    // Call the adapter immediately so pause/stop release tracks without waiting
    // for an in-progress screenshot or network request.
    let operation;
    try { operation = this.deps.setCamera(enabled); } catch { operation = false; }
    Promise.resolve(operation).then((active) => {
      if (revision !== this.cameraGeneration) return;
      const next = enabled && active === true;
      if (this.state.cameraActive !== next) {
        this.state.cameraActive = next;
        this.emit();
      }
    }, () => {
      if (revision === this.cameraGeneration && this.state.cameraActive) {
        this.state.cameraActive = false;
        this.emit();
      }
    });
  }

  start(options) {
    if (!validStart(options)) return this.getState();
    this.invalidate();
    Object.assign(this.state, {
      status: 'active', userId: options.userId, goalId: options.goalId,
      goalTitle: options.goalTitle, startedAt: new Date(this.deps.now()).toISOString(),
      sessionVerifiedSeconds: 0, checks: 0, cameraEnabled: options.camera,
      cameraActive: false, lastCheck: null, lastResult: null, error: null,
    });
    this.failures = 0;
    this.previousAt = this.deps.now();
    this.syncCamera();
    this.schedule(FIRST_CHECK_MS);
    return this.getState();
  }

  pause() {
    if (this.state.status === 'idle') return this.getState();
    this.invalidate();
    this.state.status = 'paused';
    this.state.error = null;
    this.syncCamera();
    this.emit();
    return this.getState();
  }

  resume() {
    if (!['paused', 'error'].includes(this.state.status)) return this.getState();
    this.invalidate();
    this.state.status = 'active';
    this.state.error = null;
    this.previousAt = this.deps.now();
    this.failures = 0;
    this.syncCamera();
    this.schedule(FIRST_CHECK_MS);
    return this.getState();
  }

  stop() {
    this.invalidate();
    this.state.status = 'idle';
    this.state.error = null;
    this.syncCamera();
    this.emit();
    return this.getState();
  }

  setCamera(enabled) {
    if (typeof enabled !== 'boolean') return this.getState();
    this.state.cameraEnabled = enabled;
    this.syncCamera();
    this.emit();
    return this.getState();
  }

  cameraUnavailable() {
    this.cameraGeneration += 1;
    this.state.cameraActive = false;
    this.emit();
  }

  schedule(delay) {
    if (this.state.status !== 'active') return;
    this.state.nextCheckAt = new Date(this.deps.now() + delay).toISOString();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.runCheck();
    }, delay);
    this.emit();
  }

  async runCheck() {
    if (this.state.status !== 'active') return;
    if (this.inFlight) { this.waiting = true; return; }
    this.inFlight = true;
    const generation = this.generation;
    const current = () => generation === this.generation && this.state.status === 'active';
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const started = this.deps.now();
    const sinceSeconds = Math.min(900, Math.max(5, (started - this.previousAt) / 1_000));
    this.previousAt = started;
    this.state.nextCheckAt = null;
    this.emit();
    let failureMessage = 'Screen capture failed';
    try {
      let screen = await this.deps.captureScreen({ signal });
      if (!current()) return;
      if (typeof screen !== 'string' || screen.length === 0) throw new Error('Empty screen');
      let camera = null;
      if (this.state.cameraEnabled) {
        const cameraRevision = this.cameraGeneration;
        try { camera = await this.deps.captureCamera({ signal }); } catch { camera = null; }
        if (!current()) return;
        if (cameraRevision !== this.cameraGeneration || !this.state.cameraEnabled) camera = null;
        else {
          this.state.cameraActive = typeof camera === 'string' && camera.length > 0;
          if (!this.state.cameraActive) camera = null;
          this.emit();
        }
      }
      if (!current()) return;
      failureMessage = 'Focus API unavailable';
      let result;
      try {
        result = validatedResult(await this.deps.check({
          userId: this.state.userId, goalId: this.state.goalId,
          screen, camera, sinceSeconds,
        }, { signal }));
      } finally {
        screen = null;
        camera = null;
      }
      if (!current()) return;
      this.failures = 0;
      this.state.error = null;
      this.state.checks += 1;
      this.state.sessionVerifiedSeconds += result.countedSeconds;
      this.state.lastCheck = {
        at: new Date(this.deps.now()).toISOString(), verdict: result.verdict,
        confidence: result.confidence, reason: result.reason, nudge: result.nudge,
        roast: normalizeRoast(result.roast),
        counted: result.counted, countedSeconds: result.countedSeconds,
      };
      this.state.lastResult = {
        goal: result.goal ?? null, stats: result.stats ?? null, points: result.points ?? null,
      };
      if (result.verdict === 'off_track' && result.confidence >= 0.7
        && this.deps.now() - this.lastNotificationAt >= this.notifyCooldownMs) {
        this.lastNotificationAt = this.deps.now();
        this.deps.notify(notificationBody(this.state.lastCheck, this.state.goalTitle));
      }
      this.deps.log(`${result.verdict} ${result.confidence.toFixed(2)} ${result.countedSeconds}s`);
      this.emit();
    } catch {
      if (!current()) return;
      this.failures += 1;
      this.deps.log('uncertain 0.00 0s (failed)');
      this.state.error = failureMessage;
      if (this.failures >= 3) {
        this.state.status = 'error';
        this.syncCamera();
      }
      this.emit();
    } finally {
      this.inFlight = false;
      this.abort = null;
      if (current()) this.schedule(this.state.checkSeconds * 1_000);
      else if (this.state.status === 'active' && this.waiting) {
        this.waiting = false;
        this.schedule(0);
      }
    }
  }
}
