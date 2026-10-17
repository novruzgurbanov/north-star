import { app, BrowserWindow, desktopCapturer, ipcMain, Notification,
  powerMonitor, screen, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FocusController, validPlannedMinutes, validStart, validTask } from './focus.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
function httpURL(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('WEB_URL and API_URL must be HTTP(S) URLs without credentials');
  }
  return parsed;
}
const WEB_URL = httpURL(process.env.WEB_URL || 'http://localhost:5173');
const API_URL = httpURL(process.env.API_URL || 'http://localhost:8787');
const rawSeconds = Number(process.env.CHECK_SECONDS || 20);
const CHECK_SECONDS = Number.isFinite(rawSeconds) ? Math.max(10, rawSeconds) : 20;
const rawCooldown = Number(process.env.NOTIFY_COOLDOWN_SECONDS || 20);
const NOTIFY_COOLDOWN_SECONDS = Number.isFinite(rawCooldown) ? Math.max(5, rawCooldown) : 20;
// How long a roast stays on screen before we dismiss it (Windows' own default is ~5 s).
const rawShow = Number(process.env.NOTIFY_SHOW_SECONDS || 25);
const NOTIFY_SHOW_SECONDS = Number.isFinite(rawShow) ? Math.min(120, Math.max(5, rawShow)) : 25;
const SELFTEST = process.env.NORTH_STAR_SELFTEST === '1';
const CAPTURE_URL = pathToFileURL(join(ROOT, 'capture.html')).href;
const runtimePath = join(ROOT, '.north-star-runtime', SELFTEST ? 'selftest' : 'app');
mkdirSync(runtimePath, { recursive: true });
app.setPath('userData', runtimePath);
app.setName('North Star');
app.setAppUserModelId('NorthStar.Desktop');

let mainWindow = null;
let captureWindow = null;
let captureReady = null;
let focus = null;
let retryTimer = null;
let quitting = false;
let selftestQuitting = false;
let cameraWanted = false;
let cameraRevision = 0;
const captureRequests = new Map();
const notifications = new Set();

function sameWebOrigin(url) {
  try { return new URL(url).origin === WEB_URL.origin; } catch { return false; }
}

function external(url) {
  try {
    if (typeof url !== 'string' || url.length > 8_192) return;
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) {
      void shell.openExternal(url).catch(() => {});
    }
  } catch { /* Ignore malformed links. */ }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus:state', state);
  }
  if (SELFTEST && state.checks >= 2 && !selftestQuitting) {
    selftestQuitting = true;
    // Give the renderer time to receive state and acknowledge it to the mock.
    setTimeout(() => app.quit(), 1_000);
  }
}

const NOT_SUPPORTED_NOTICE = "Windows notifications aren't available, so roasts will only show in the app.";
const BLOCKED_NOTICE = 'Windows is blocking North Star notifications. Turn them on in Settings > System > Notifications.';

function notify(body) {
  if (!Notification.isSupported()) {
    focus?.setNotice(NOT_SUPPORTED_NOTICE);
    return;
  }
  try {
    // A newer roast replaces the one still on screen instead of stacking up.
    for (const previous of notifications) {
      try { previous.close(); } catch { /* already gone */ }
    }
    notifications.clear();
    // Windows hides normal toasts after ~5 s; 'never' keeps it up, and we close it ourselves.
    const notification = new Notification({ title: 'North Star', body, silent: false, timeoutType: 'never' });
    notifications.add(notification);
    const autoClose = setTimeout(() => {
      try { notification.close(); } catch { /* already gone */ }
    }, NOTIFY_SHOW_SECONDS * 1_000);
    const forget = () => { clearTimeout(autoClose); notifications.delete(notification); };
    notification.on('click', () => { forget(); showMainWindow(); });
    notification.on('show', () => focus?.setNotice(null));
    notification.on('close', forget);
    notification.on('failed', () => {
      forget();
      focus?.setNotice(BLOCKED_NOTICE);
    });
    notification.show();
  } catch { /* Notification availability must not fail a focus check. */ }
}

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const aspect = display.size.width / display.size.height;
  const width = Math.max(1, Math.round(Math.min(1280, 720 * aspect)));
  const height = Math.max(1, Math.round(width / aspect));
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture failed');
  return source.thumbnail.toJPEG(70).toString('base64');
}

async function postCheck(payload, { signal }) {
  const timeout = AbortSignal.timeout(45_000);
  const response = await fetch(new URL('/api/focus/check', API_URL), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.any([signal, timeout]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Focus API unavailable');
  }
  return response.json();
}

function captureCommand(action, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Capture canceled')); return; }
    const id = randomUUID();
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      captureRequests.delete(id);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('Capture canceled'));
    timer = setTimeout(() => finish(new Error('Camera timed out')), 3_000);
    signal?.addEventListener('abort', abort, { once: true });
    captureRequests.set(id, finish);
    Promise.resolve(captureReady).then(() => {
      if (!captureRequests.has(id)) return;
      if (!captureWindow || captureWindow.isDestroyed()) throw new Error('Camera unavailable');
      captureWindow.webContents.send('capture:command', { id, action });
    }).catch(() => finish(new Error('Camera unavailable')));
  });
}

async function setCamera(enabled) {
  cameraWanted = enabled;
  const revision = ++cameraRevision;
  try {
    const result = await captureCommand(enabled ? 'enable' : 'disable');
    return revision === cameraRevision && enabled && result.active;
  } catch {
    if (revision === cameraRevision && enabled) {
      // Cancel a still-pending getUserMedia so a late grant cannot leave tracks on.
      void captureCommand('disable').catch(() => {});
    }
    return false;
  }
}

async function captureCamera({ signal }) {
  if (!cameraWanted) return null;
  const revision = cameraRevision;
  try {
    const result = await captureCommand('frame', { signal });
    if (revision !== cameraRevision || !cameraWanted) return null;
    if (!result.active || !result.frame) throw new Error('Camera unavailable');
    return result.frame;
  } catch {
    if (revision === cameraRevision) void captureCommand('disable').catch(() => {});
    return null;
  }
}

function trustedRenderer(event) {
  return mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && sameWebOrigin(event.senderFrame.url);
}

function registerIPC() {
  const actions = {
    start: (args) => args.length === 1 && validStart(args[0]),
    pause: (args) => args.length === 0,
    resume: (args) => args.length === 0,
    stop: (args) => args.length === 0,
    'set-camera': (args) => args.length === 1 && typeof args[0] === 'boolean',
    'get-state': (args) => args.length === 0,
  };
  const methods = { 'set-camera': 'setCamera', 'get-state': 'getState' };
  for (const [action, validate] of Object.entries(actions)) {
    ipcMain.handle(`focus:${action}`, (event, ...args) => {
      if (!trustedRenderer(event)) return undefined;
      if (!validate(args)) return focus.getState();
      if (action === 'start') {
        // Optional session fields are sanitized one by one (like configure):
        // an invalid task or plannedMinutes is ignored, never blocks the start.
        const [options] = args;
        return focus.start({
          userId: options.userId, goalId: options.goalId, goalTitle: options.goalTitle,
          camera: options.camera, task: validTask(options.task),
          plannedMinutes: validPlannedMinutes(options.plannedMinutes),
        });
      }
      return focus[methods[action] || action](...args);
    });
  }
  // configure() applies field by field, so one malformed key must not drop a
  // valid sibling; the controller re-validates everything it is given.
  ipcMain.handle('focus:configure', (event, ...args) => {
    if (!trustedRenderer(event) || args.length !== 1 || !args[0]
      || typeof args[0] !== 'object' || Array.isArray(args[0])) return focus.getState();
    const options = {};
    if (Number.isInteger(args[0].checkSeconds)
      && args[0].checkSeconds >= 10 && args[0].checkSeconds <= 300) {
      options.checkSeconds = args[0].checkSeconds;
    }
    if (typeof args[0].notifications === 'boolean') options.notifications = args[0].notifications;
    return focus.configure(options);
  });
  ipcMain.on('capture:reply', (event, reply, ...extra) => {
    if (!captureWindow || captureWindow.isDestroyed() || extra.length
      || event.sender !== captureWindow.webContents
      || event.senderFrame !== captureWindow.webContents.mainFrame
      || event.senderFrame.url !== CAPTURE_URL
      || !reply || typeof reply !== 'object' || Array.isArray(reply)
      || typeof reply.id !== 'string' || reply.id.length > 100
      || typeof reply.active !== 'boolean'
      || (reply.frame !== undefined && (typeof reply.frame !== 'string'
        || reply.frame.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(reply.frame)))) return;
    captureRequests.get(reply.id)?.(null, reply);
  });
}

function configurePermissions(ses) {
  function allowed(wc, permission, origin, details = {}) {
    if (permission !== 'media' || !wc || wc.isDestroyed()) return false;
    if (wc === mainWindow?.webContents) {
      return sameWebOrigin(wc.getURL()) && sameWebOrigin(origin)
        && (!details.embeddingOrigin || sameWebOrigin(details.embeddingOrigin));
    }
    return wc === captureWindow?.webContents && wc.getURL() === CAPTURE_URL
      && (origin === CAPTURE_URL || origin === 'file://' || origin === 'file:///' || origin === 'null')
      && cameraWanted && focus?.getState().status === 'active';
  }
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowed(wc, permission, details.securityOrigin || origin, details));
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowed(wc, permission, details.requestingUrl, details)));
  ses.on('will-download', (event) => event.preventDefault());
}

const FALLBACK_HTML = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>North Star</title><style>
body{margin:0;background:#020309;color:#c9d4f2;font:18px system-ui;display:grid;min-height:100vh;place-items:center}
main{max-width:600px;padding:40px}h1{color:#fff}code{color:#fff}p{line-height:1.6}
header{position:fixed;inset:0 150px auto 0;height:40px;-webkit-app-region:drag}
</style><header></header><main><h1>North Star</h1><p>Start the web UI by running
<code>npm run dev</code> from the <code>north-star</code> folder.</p>
<p>Waiting for the web UI. Retrying every 3 seconds…</p></main></html>`;

async function loadWebUI() {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadURL(WEB_URL.href);
    if (!sameWebOrigin(mainWindow.webContents.getURL())) throw new Error('Unexpected redirect');
    sendState(focus.getState());
  } catch {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FALLBACK_HTML)}`).catch(() => {});
    if (!quitting) retryTimer = setTimeout(() => void loadWebUI(), 3_000);
  }
}

function createWindows() {
  const ses = session.fromPartition('persist:north-star', { cache: false }); // persist: keeps localStorage (who you are) across launches
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: 'North Star', backgroundColor: '#020309', show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#020309', symbolColor: '#c9d4f2', height: 40 },
    webPreferences: { preload: join(ROOT, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, session: ses, webviewTag: false },
  });
  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('page-title-updated', (event) => { event.preventDefault(); });
  mainWindow.on('close', () => { focus.stop(); app.quit(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  const contents = mainWindow.webContents;
  const guardNavigation = (event, url) => {
    if (!sameWebOrigin(url)) { event.preventDefault(); external(url); }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-frame-navigate', (event) => {
    if (!sameWebOrigin(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (sameWebOrigin(url)) void mainWindow.loadURL(url).catch(() => {});
    else external(url);
    return { action: 'deny' };
  });
  contents.on('render-process-gone', () => focus.pause());
  if (SELFTEST) {
    contents.on('console-message', (event) => {
      // Only forward known self-test markers; never forward arbitrary page data.
      if (/^NORTH_STAR_SELFTEST_(STATE|ERROR) /.test(event.message)) {
        console.log(event.message.slice(0, 500));
      }
    });
  }

  captureWindow = new BrowserWindow({
    show: false, width: 640, height: 360, skipTaskbar: true,
    webPreferences: { preload: join(ROOT, 'capture-preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      session: ses, webviewTag: false },
  });
  captureWindow.setMenu(null);
  captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  captureWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  captureWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  captureWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  captureWindow.webContents.on('render-process-gone', () => {
    focus.cameraUnavailable();
  });
  configurePermissions(ses);
  captureReady = captureWindow.loadFile(join(ROOT, 'capture.html'));
  // The camera is optional; a failed helper load must not prevent screen checks.
  captureReady.catch(() => {});
  void loadWebUI();
}

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  clearTimeout(retryTimer);
  focus?.stop();
  for (const finish of captureRequests.values()) finish(new Error('App closing'));
  notifications.forEach((notification) => notification.close());
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  focus = new FocusController({
    checkSeconds: CHECK_SECONDS, notifyCooldownSeconds: NOTIFY_COOLDOWN_SECONDS,
    captureScreen, captureCamera, setCamera,
    check: postCheck, onState: sendState, notify,
    log: (line) => console.log(`[focus] ${line}`),
  });
  registerIPC();
  createWindows();
  powerMonitor.on('lock-screen', () => focus.pause());
  powerMonitor.on('suspend', () => focus.pause());
}).catch(() => {
  console.error('North Star could not start its desktop windows.');
  app.exit(1);
});
