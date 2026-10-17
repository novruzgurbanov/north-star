import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../focus.mjs';

const OPTIONS = { userId: 'user-1', goalId: 'goal-1', goalTitle: 'Build North Star', camera: false };
const result = (overrides = {}) => ({
  verdict: 'on_track', confidence: 0.9, reason: "You're building your app.",
  nudge: '', counted: true, countedSeconds: 5,
  goal: { id: 'goal-1' }, stats: { score: 1 }, points: { score: 1 }, ...overrides,
});
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Clock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (fn, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, fn });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  async tick(ms) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

function harness(overrides = {}) {
  const clock = new Clock();
  const requests = [];
  const cameras = [];
  const notifications = [];
  const states = [];
  const controller = new FocusController({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    checkSeconds: 10, captureScreen: async () => 'fake-jpeg',
    captureCamera: async () => 'fake-camera',
    setCamera: async (enabled) => { cameras.push(enabled); return enabled; },
    check: async (body) => { requests.push(body); return result({ countedSeconds: body.sinceSeconds }); },
    notify: (body) => notifications.push({ at: clock.time, body }),
    onState: (state) => states.push(state), ...overrides,
  });
  return { clock, controller, requests, cameras, notifications, states };
}

test('start publishes the exact bridge state and schedules first check at 5 seconds', async () => {
  const { controller, clock, requests } = harness();
  const state = controller.start(OPTIONS);
  assert.deepEqual(Object.keys(state).sort(), [
    'status', 'userId', 'goalId', 'goalTitle', 'startedAt', 'nextCheckAt', 'checkSeconds',
    'notificationsEnabled', 'sessionVerifiedSeconds', 'checks', 'cameraEnabled', 'cameraActive',
    'lastCheck', 'lastResult', 'error', 'notice',
    'task', 'plannedMinutes', 'activeSeconds', 'activeSince', 'history', 'lastSession',
  ].sort());
  assert.equal(state.notice, null);
  assert.equal(state.notificationsEnabled, true);
  assert.equal(state.status, 'active');
  assert.equal(state.startedAt, new Date(0).toISOString());
  assert.equal(state.nextCheckAt, new Date(5_000).toISOString());
  assert.equal(state.task, null);
  assert.equal(state.plannedMinutes, null);
  assert.equal(state.activeSeconds, 0);
  assert.equal(state.activeSince, state.startedAt);
  assert.deepEqual(state.history, []);
  assert.equal(state.lastSession, null);
  await clock.tick(4_999);
  assert.equal(requests.length, 0);
  await clock.tick(1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sinceSeconds, 5);
  assert.equal(controller.getState().checks, 1);
  assert.equal(controller.getState().sessionVerifiedSeconds, 5);
  assert.equal(controller.getState().nextCheckAt, new Date(15_000).toISOString());
  assert.equal(controller.getState().history.length, 1);
  assert.equal(controller.getState().activeSeconds, 0); // banked only on pause/stop/error/completion
  assert.equal(controller.getState().activeSince, new Date(0).toISOString());
  assert.deepEqual(controller.getState().lastResult, {
    goal: result().goal, stats: result().stats, points: result().points,
  });
});

test('pause cancels timers; resume excludes all paused time from sinceSeconds', async () => {
  const { controller, clock, requests, cameras } = harness();
  controller.start({ ...OPTIONS, camera: true });
  await clock.tick(5_000);
  controller.pause();
  assert.equal(controller.getState().nextCheckAt, null);
  assert.equal(cameras.at(-1), false);
  await clock.tick(120_000);
  assert.equal(requests.length, 1);
  controller.resume();
  await clock.tick(5_000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].sinceSeconds, 5);
  await clock.tick(10_000);
  assert.equal(requests[2].sinceSeconds, 10);
});

test('slow API calls do not overlap and next check waits until completion', async () => {
  const pending = deferred();
  let calls = 0;
  const { controller, clock } = harness({ check: () => { calls += 1; return pending.promise; } });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  await clock.tick(60_000);
  assert.equal(calls, 1);
  assert.equal(controller.getState().nextCheckAt, null);
  pending.resolve(result());
  await flush();
  assert.equal(controller.getState().nextCheckAt, new Date(75_000).toISOString());
  await clock.tick(9_999);
  assert.equal(calls, 1);
  await clock.tick(1);
  assert.equal(calls, 2);
});

test('goal switch during an in-flight call cannot overlap or apply a stale result', async () => {
  const pending = deferred();
  const calls = [];
  const { controller, clock } = harness({ check: (body, { signal }) => {
    calls.push({ body, signal });
    return calls.length === 1 ? pending.promise : Promise.resolve(result());
  } });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  controller.start({ ...OPTIONS, goalId: 'goal-2' });
  assert.equal(calls[0].signal.aborted, true);
  await clock.tick(5_000);
  assert.equal(calls.length, 1);
  pending.resolve(result({ countedSeconds: 900 }));
  await flush();
  assert.equal(controller.getState().sessionVerifiedSeconds, 0);
  await clock.tick(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.goalId, 'goal-2');
  assert.equal(controller.getState().checks, 1);
  assert.equal(controller.getState().sessionVerifiedSeconds, 5);
});

test('a confident off-track check notifies with the roast, at most once per 20 seconds', async () => {
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.7, roast: 'That tab is not your star.',
    nudge: 'Come back to your star.', counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, 'That tab is not your star.');
  assert.equal(controller.getState().lastCheck.roast, 'That tab is not your star.');
  await clock.tick(10_000);
  assert.equal(notifications.length, 1);
  await clock.tick(10_000);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].at - notifications[0].at, 20_000);
});

test('a suppressed notification does not delay the next allowed one', async () => {
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.9, counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  assert.equal(notifications.length, 1);
  await clock.tick(10_000);
  assert.equal(notifications.length, 1);
  await clock.tick(10_000);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].at - notifications[0].at, 20_000);
});

test('low-confidence off-track checks never notify', async () => {
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.69, counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(65_000);
  assert.equal(notifications.length, 0);
});

test('uncertain and on-track checks never notify', async () => {
  const verdicts = [['uncertain', 0.9], ['on_track', 0.9], ['uncertain', 0]];
  const { controller, clock, notifications } = harness({ check: async () => {
    const [verdict, confidence] = verdicts.shift();
    return result({ verdict, confidence, counted: false, countedSeconds: 0 });
  } });
  controller.start(OPTIONS);
  await clock.tick(65_000);
  assert.equal(notifications.length, 0);
});

test('the notification body falls back to the nudge, then to the default text', async () => {
  const nudges = ['Come back to your star.', '', '   ', '', ''];
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.9, roast: '', nudge: nudges.shift(),
    counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  assert.equal(notifications[0].body, 'Come back to your star.');
  await clock.tick(20_000);
  assert.equal(notifications[1].body, 'Your star is waiting. Back to Build North Star?');
  await clock.tick(20_000);
  assert.equal(notifications[2].body, 'Your star is waiting. Back to Build North Star?');
  assert.equal(notifications.length, 3);
});

test('the notification cooldown is configurable', async () => {
  const { controller, clock, notifications } = harness({ notifyCooldownSeconds: 30,
    check: async () => result({
      verdict: 'off_track', confidence: 0.9, counted: false, countedSeconds: 0,
    }) });
  controller.start(OPTIONS);
  await clock.tick(35_000);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].at - notifications[0].at, 30_000);
});

test('the default check interval is 20 seconds', async () => {
  const clock = new Clock();
  const requests = [];
  const controller = new FocusController({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    captureScreen: async () => 'fake-jpeg',
    check: async (body) => { requests.push(body); return result({ countedSeconds: body.sinceSeconds }); },
  });
  controller.start(OPTIONS);
  assert.equal(controller.getState().checkSeconds, 20);
  await clock.tick(5_000);
  assert.equal(requests.length, 1);
  await clock.tick(19_999);
  assert.equal(requests.length, 1);
  await clock.tick(1);
  assert.equal(requests.length, 2);
});

test('setNotice publishes non-empty notices and clears them', async () => {
  const { controller, states } = harness();
  const initial = controller.getState();
  const state = controller.setNotice('Windows is blocking North Star notifications.');
  assert.equal(state.notice, 'Windows is blocking North Star notifications.');
  assert.equal(controller.setNotice('   ').notice, null);
  assert.equal(controller.setNotice('Back').notice, 'Back');
  assert.equal(controller.setNotice('Back').notice, 'Back');
  controller.stop();
  assert.equal(controller.getState().notice, 'Back');
  assert.deepEqual(initial.notice, null);
  assert.equal(states.at(-1).notice, 'Back');
});

for (const stage of ['captureScreen', 'check']) {
  test(`three consecutive ${stage} failures enter error; resume retries`, async () => {
    let failing = true;
    const { controller, clock, cameras } = harness({ [stage]: async () => {
      if (failing) throw new Error('Private implementation detail must not reach the UI');
      return stage === 'captureScreen' ? 'fake-jpeg' : result();
    } });
    controller.start({ ...OPTIONS, camera: true });
    await clock.tick(15_000);
    assert.equal(controller.getState().status, 'active');
    await clock.tick(10_000);
    assert.equal(controller.getState().status, 'error');
    assert.equal(controller.getState().error, stage === 'captureScreen'
      ? 'Screen capture failed' : 'Focus API unavailable');
    assert.equal(controller.getState().nextCheckAt, null);
    assert.equal(cameras.at(-1), false);
    failing = false;
    controller.resume();
    await clock.tick(5_000);
    assert.equal(controller.getState().status, 'active');
    assert.equal(controller.getState().checks, 1);
    assert.equal(controller.getState().error, null);
  });
}

test('stop releases camera, cancels timers, and keeps lastCheck for display', async () => {
  const { controller, clock, cameras, requests } = harness();
  controller.start({ ...OPTIONS, camera: true });
  await clock.tick(5_000);
  const lastCheck = controller.getState().lastCheck;
  controller.stop();
  assert.equal(cameras.at(-1), false);
  assert.equal(controller.getState().status, 'idle');
  assert.equal(controller.getState().cameraActive, false);
  assert.equal(controller.getState().nextCheckAt, null);
  assert.deepEqual(controller.getState().lastCheck, lastCheck);
  await clock.tick(60_000);
  assert.equal(requests.length, 1);
});

test('camera failure falls back to screen-only without failing the check', async () => {
  const { controller, clock, requests } = harness({ captureCamera: async () => { throw new Error('No webcam'); } });
  controller.start({ ...OPTIONS, camera: true });
  await clock.tick(5_000);
  assert.equal(requests[0].camera, null);
  assert.equal(controller.getState().cameraEnabled, true);
  assert.equal(controller.getState().cameraActive, false);
  assert.equal(controller.getState().checks, 1);
});

test('camera toggles immediately; stale activation cannot reactivate a stopped session', async () => {
  const activation = deferred();
  const cameras = [];
  const { controller } = harness({ setCamera: (enabled) => {
    cameras.push(enabled);
    return enabled ? activation.promise : Promise.resolve(false);
  } });
  controller.start(OPTIONS);
  controller.setCamera(true);
  assert.equal(cameras.at(-1), true);
  controller.stop();
  activation.resolve(true);
  await flush();
  assert.equal(cameras.at(-1), false);
  assert.equal(controller.getState().cameraActive, false);
});

test('malformed inputs and API responses cannot mutate the session or award time', async () => {
  const { controller, clock } = harness({ check: async () => result({ countedSeconds: -1 }) });
  const initial = controller.getState();
  for (const input of [null, {}, { ...OPTIONS, userId: '' }, { ...OPTIONS, goalTitle: 'x'.repeat(501) },
    { ...OPTIONS, camera: 'yes' }]) assert.deepEqual(controller.start(input), initial);
  assert.deepEqual(controller.setCamera('yes'), initial);
  controller.start(OPTIONS);
  await clock.tick(5_000);
  assert.equal(controller.getState().checks, 0);
  assert.equal(controller.getState().sessionVerifiedSeconds, 0);
});

test('sinceSeconds clamps to 900 after a long call', async () => {
  const pending = deferred();
  const requests = [];
  const { controller, clock } = harness({ check: (body) => {
    requests.push(body);
    return requests.length === 1 ? pending.promise : Promise.resolve(result());
  } });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  await clock.tick(1_000_000);
  pending.resolve(result());
  await flush();
  await clock.tick(10_000);
  assert.equal(requests[1].sinceSeconds, 900);
});

test('pause during a pending screenshot discards it; resume starts a fresh accounting window', async () => {
  const pending = deferred();
  let captures = 0;
  const { controller, clock, requests } = harness({ captureScreen: () => {
    captures += 1;
    return captures === 1 ? pending.promise : Promise.resolve('fresh-screen');
  } });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  controller.pause();
  await clock.tick(60_000);
  pending.resolve('stale-screen');
  await flush();
  assert.equal(requests.length, 0);
  controller.resume();
  await clock.tick(5_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].screen, 'fresh-screen');
  assert.equal(requests[0].sinceSeconds, 5);
});

test('turning camera off during a frame grab excludes the stale frame from the request', async () => {
  const pending = deferred();
  const { controller, clock, requests, cameras } = harness({ captureCamera: () => pending.promise });
  controller.start({ ...OPTIONS, camera: true });
  await clock.tick(5_000);
  controller.setCamera(false);
  assert.equal(cameras.at(-1), false);
  pending.resolve('stale-camera-frame');
  await flush();
  assert.equal(requests[0].camera, null);
  assert.equal(controller.getState().cameraActive, false);
});

test('a successful response resets the consecutive failure count', async () => {
  let calls = 0;
  const { controller, clock } = harness({ check: async () => {
    calls += 1;
    if (calls !== 3) throw new Error('Offline');
    return result();
  } });
  controller.start(OPTIONS);
  await clock.tick(45_000);
  assert.equal(controller.getState().status, 'active');
  assert.equal(controller.getState().checks, 1);
  await clock.tick(10_000);
  assert.equal(controller.getState().status, 'error');
});

test('camera loss preserves the user preference and invalidates late activation', async () => {
  const pending = deferred();
  const { controller } = harness({ setCamera: () => pending.promise });
  controller.start({ ...OPTIONS, camera: true });
  controller.cameraUnavailable();
  pending.resolve(true);
  await flush();
  assert.equal(controller.getState().cameraEnabled, true);
  assert.equal(controller.getState().cameraActive, false);
});

test('configure shortens the interval and reschedules the pending check to lastCheck + interval', async () => {
  const { controller, clock, requests } = harness({ checkSeconds: 60 });
  controller.start(OPTIONS);
  await clock.tick(5_000); // first check at t=5s; the next one is armed to fire at t=65s
  await clock.tick(1_000); // t=6s
  const state = controller.configure({ checkSeconds: 10 });
  assert.equal(state.checkSeconds, 10);
  assert.equal(state.nextCheckAt, new Date(15_000).toISOString()); // 5s + 10s, not 65s
  await clock.tick(8_999);
  assert.equal(requests.length, 1);
  await clock.tick(1);
  assert.equal(requests.length, 2); // fired at t=15s
  assert.equal(requests[1].sinceSeconds, 10);
  assert.equal(controller.getState().nextCheckAt, new Date(25_000).toISOString()); // 10s after check 2
  await clock.tick(9_999);
  assert.equal(requests.length, 2);
  await clock.tick(1);
  assert.equal(requests.length, 3); // every following check keeps the new interval
});

test('a longer interval leaves the pending check in place; the next one uses it', async () => {
  const { controller, clock, requests } = harness();
  controller.start(OPTIONS);
  await clock.tick(5_000); // check 1 done; pending check fires at t=15s
  const state = controller.configure({ checkSeconds: 30 });
  assert.equal(state.checkSeconds, 30);
  assert.equal(state.nextCheckAt, new Date(15_000).toISOString()); // untouched
  await clock.tick(10_000);
  assert.equal(requests.length, 2); // still fired at t=15s
  await clock.tick(29_999);
  assert.equal(requests.length, 2);
  await clock.tick(1);
  assert.equal(requests.length, 3); // t=45s, exactly 30s after check 2
});

test('a rescheduled check never fires earlier than 1 second from now', async () => {
  const { controller, clock, requests } = harness({ checkSeconds: 300 });
  controller.start(OPTIONS);
  await clock.tick(5_000); // check 1 at t=5s; pending fires at t=305s
  await clock.tick(195_000); // t=200s
  const state = controller.configure({ checkSeconds: 10 });
  // lastCheck (t=5s) + 10s is already in the past, so it clamps to t=201s.
  assert.equal(state.nextCheckAt, new Date(201_000).toISOString());
  await clock.tick(999);
  assert.equal(requests.length, 1);
  await clock.tick(1);
  assert.equal(requests.length, 2);
});

test('invalid configure arguments are ignored, valid siblings still apply', async () => {
  const { controller, clock, requests } = harness();
  controller.start(OPTIONS);
  await clock.tick(5_000);
  const before = controller.getState();
  for (const options of [null, 'x', 42, [], {},
    { checkSeconds: 5 }, { checkSeconds: 301 }, { checkSeconds: 20.5 },
    { checkSeconds: '30' }, { checkSeconds: Number.NaN }, { notifications: 'yes' },
    { notifications: 1 }]) {
    assert.deepEqual(controller.configure(options), before);
  }
  const state = controller.configure({ checkSeconds: 5, notifications: false });
  assert.equal(state.checkSeconds, before.checkSeconds);
  assert.equal(state.notificationsEnabled, false);
  assert.equal(controller.configure({ notifications: true }).notificationsEnabled, true);
  await clock.tick(10_000);
  assert.equal(requests.length, 2); // the interval was never touched; checks keep firing
});

test('notifications disabled never notify; re-enabling restores them', async () => {
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.9, counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  assert.equal(controller.configure({ notifications: false }).notificationsEnabled, false);
  await clock.tick(65_000); // seven confident off-track checks
  assert.equal(notifications.length, 0);
  assert.equal(controller.getState().error, null);
  controller.configure({ notifications: true });
  await clock.tick(10_000);
  assert.equal(notifications.length, 1);
  await clock.tick(10_000); // inside the 20s cooldown
  assert.equal(notifications.length, 1);
});

test('notifyAbove from the API is respected: 0.6 notifies at 0.65 and 0.6', async () => {
  const confidences = [0.65, 0.6, 0.6];
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: confidences.shift(), notifyAbove: 0.6,
    counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(5_000);
  assert.equal(notifications.length, 1);
  await clock.tick(10_000); // cooldown suppresses the second
  assert.equal(notifications.length, 1);
  await clock.tick(10_000);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].at - notifications[0].at, 20_000);
});

test('notifyAbove 0.85 does not notify at 0.8', async () => {
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: 0.8, notifyAbove: 0.85, counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(65_000);
  assert.equal(notifications.length, 0);
});

test('a malformed notifyAbove falls back to the 0.7 default', async () => {
  const confidences = [0.65, 0.75, 0.65, 0.65];
  const payloads = ['high', 1.5, -0.5, null];
  const { controller, clock, notifications } = harness({ check: async () => result({
    verdict: 'off_track', confidence: confidences.shift(), notifyAbove: payloads.shift(),
    counted: false, countedSeconds: 0,
  }) });
  controller.start(OPTIONS);
  await clock.tick(35_000); // checks at 5s, 15s, 25s, 35s
  assert.equal(notifications.length, 1); // only the 0.75 check clears the 0.7 fallback
  assert.equal(notifications[0].at, 15_000);
});

test('start stores a trimmed task and plannedMinutes; invalid values are ignored', async () => {
  const { controller, clock } = harness();
  const state = controller.start({ ...OPTIONS, task: '  Outline the recap flow  ', plannedMinutes: 25 });
  assert.equal(state.task, 'Outline the recap flow');
  assert.equal(state.plannedMinutes, 25);
  controller.stop();
  for (const task of [undefined, null, 42, '', '   ', 'x'.repeat(121)]) {
    const next = controller.start({ ...OPTIONS, task });
    assert.equal(next.task, null);
    assert.equal(next.status, 'active'); // the session still starts
    controller.stop();
  }
  for (const plannedMinutes of [undefined, null, 4, 181, 25.5, '25', Number.NaN]) {
    const next = controller.start({ ...OPTIONS, plannedMinutes });
    assert.equal(next.plannedMinutes, null);
    assert.equal(next.status, 'active');
    controller.stop();
  }
  assert.equal(controller.start({ ...OPTIONS, task: 'x'.repeat(120) }).task, 'x'.repeat(120));
  controller.stop();
  assert.equal(controller.start({ ...OPTIONS, plannedMinutes: 5 }).plannedMinutes, 5);
  controller.stop();
  assert.equal(controller.start({ ...OPTIONS, plannedMinutes: 180 }).plannedMinutes, 180);
  controller.stop();
  // An invalid plannedMinutes never arms a completion timer.
  controller.start({ ...OPTIONS, plannedMinutes: 4 });
  await clock.tick(600_000);
  assert.equal(controller.getState().status, 'active');
});

test('plannedMinutes completion fires after the planned active time, excluding a pause', async () => {
  const { controller, clock, requests } = harness();
  controller.start({ ...OPTIONS, task: 'Draft the recap', plannedMinutes: 5 });
  await clock.tick(100_000);
  assert.equal(controller.getState().status, 'active');
  const paused = controller.pause();
  assert.equal(paused.activeSeconds, 100);
  assert.equal(paused.activeSince, null);
  await clock.tick(120_000); // paused time must not count toward the plan
  assert.equal(controller.getState().status, 'paused');
  assert.equal(controller.getState().lastSession, null);
  const resumed = controller.resume();
  assert.equal(resumed.activeSince, new Date(220_000).toISOString());
  await clock.tick(199_999);
  assert.equal(controller.getState().status, 'active');
  await clock.tick(1); // 100 active seconds before the pause + 200 after it
  const done = controller.getState();
  assert.equal(done.status, 'idle');
  assert.equal(done.lastSession.completed, true);
  assert.equal(done.lastSession.activeSeconds, 300);
  assert.equal(done.lastSession.verifiedSeconds, 290);
  assert.equal(done.lastSession.plannedMinutes, 5);
  assert.equal(done.task, 'Draft the recap');
  await clock.tick(60_000);
  assert.equal(requests.length, 30); // no further checks after completion
});

test('a completed session records the full lastSession', async () => {
  const { controller, clock, requests, cameras } = harness();
  controller.start({ ...OPTIONS, task: 'Write docs', plannedMinutes: 5 });
  await clock.tick(300_000);
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.cameraActive, false);
  assert.equal(state.nextCheckAt, null);
  assert.equal(cameras.at(-1), false); // camera released
  const done = state.lastSession;
  assert.deepEqual(Object.keys(done).sort(), [
    'goalId', 'goalTitle', 'task', 'plannedMinutes', 'activeSeconds',
    'verifiedSeconds', 'history', 'completed', 'endedAt',
  ].sort());
  assert.equal(done.goalId, 'goal-1');
  assert.equal(done.goalTitle, 'Build North Star');
  assert.equal(done.task, 'Write docs');
  assert.equal(done.plannedMinutes, 5);
  assert.equal(done.activeSeconds, 300);
  assert.equal(done.verifiedSeconds, 295);
  assert.equal(done.completed, true);
  assert.equal(done.endedAt, new Date(300_000).toISOString());
  assert.equal(done.history.length, 30);
  assert.deepEqual(Object.keys(done.history[0]).sort(),
    ['at', 'verdict', 'confidence', 'reason', 'counted', 'countedSeconds'].sort());
  assert.deepEqual(done.history[0], {
    at: new Date(5_000).toISOString(), verdict: 'on_track', confidence: 0.9,
    reason: "You're building your app.", counted: true, countedSeconds: 5,
  });
  await clock.tick(60_000);
  assert.equal(requests.length, 30); // the session stayed ended
});

test('stop while active records lastSession with completed false', async () => {
  const { controller, clock } = harness();
  controller.start({ ...OPTIONS, task: 'Read the spec', plannedMinutes: 25 });
  await clock.tick(5_000);
  const state = controller.stop();
  assert.equal(state.status, 'idle');
  const done = state.lastSession;
  assert.equal(done.completed, false);
  assert.equal(done.goalId, 'goal-1');
  assert.equal(done.goalTitle, 'Build North Star');
  assert.equal(done.task, 'Read the spec');
  assert.equal(done.plannedMinutes, 25);
  assert.equal(done.activeSeconds, 5);
  assert.equal(done.verifiedSeconds, 5);
  assert.equal(done.history.length, 1);
  assert.equal(done.endedAt, new Date(5_000).toISOString());
  // Stopping again from idle must not overwrite the record.
  assert.deepEqual(controller.stop().lastSession, done);
});

test('stop from idle does not create a lastSession', () => {
  const { controller } = harness();
  assert.equal(controller.stop().lastSession, null);
});

test('history keeps the newest 200 checks of the session', async () => {
  const { controller, clock } = harness();
  controller.start(OPTIONS);
  await clock.tick(2_100_000); // checks at 5 s then every 10 s → 210 checks
  const state = controller.getState();
  assert.equal(state.checks, 210);
  assert.equal(state.history.length, 200);
  assert.equal(state.history[0].at, new Date(105_000).toISOString()); // oldest 10 dropped
  assert.equal(state.history.at(-1).at, new Date(2_095_000).toISOString());
});

test('start clears lastSession and history from the previous session', async () => {
  const { controller, clock } = harness();
  controller.start(OPTIONS);
  await clock.tick(15_000); // two checks
  assert.equal(controller.getState().history.length, 2);
  controller.stop();
  assert.notEqual(controller.getState().lastSession, null);
  const next = controller.start({ ...OPTIONS, task: 'Fresh start' });
  assert.equal(next.lastSession, null);
  assert.deepEqual(next.history, []);
  assert.equal(next.checks, 0);
  assert.equal(next.sessionVerifiedSeconds, 0);
  assert.equal(next.activeSeconds, 0);
});

test('a check in flight when time is up is included when it lands within 5 seconds', async () => {
  const pending = deferred();
  let calls = 0;
  const { controller, clock } = harness({ check: () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(result({ countedSeconds: 5 }));
    if (calls === 30) return pending.promise;
    return Promise.resolve(result({ countedSeconds: 10 }));
  } });
  controller.start({ ...OPTIONS, plannedMinutes: 5 });
  await clock.tick(294_999); // 29 checks done (t=5..285)
  assert.equal(calls, 29);
  await clock.tick(1); // the 30th check starts at t=295 s and hangs
  assert.equal(calls, 30);
  await clock.tick(5_000); // t=300 s: completion fires while the check is in flight
  assert.equal(controller.getState().status, 'active'); // grace window, not finalized yet
  assert.equal(controller.getState().lastSession, null);
  pending.resolve(result({ countedSeconds: 10 }));
  await flush();
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastSession.completed, true);
  assert.equal(state.lastSession.activeSeconds, 300);
  assert.equal(state.lastSession.verifiedSeconds, 295); // the late check is included
  assert.equal(state.lastSession.history.length, 30);
  const endedAt = state.lastSession.endedAt;
  await clock.tick(10_000); // the grace deadline must not finalize a second time
  assert.equal(controller.getState().status, 'idle');
  assert.equal(controller.getState().lastSession.endedAt, endedAt);
});

test('a check still in flight 5 seconds after time is up is ignored', async () => {
  const pending = deferred();
  let calls = 0;
  const { controller, clock } = harness({ check: () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(result({ countedSeconds: 5 }));
    if (calls === 30) return pending.promise;
    return Promise.resolve(result({ countedSeconds: 10 }));
  } });
  controller.start({ ...OPTIONS, plannedMinutes: 5 });
  await clock.tick(295_000); // the 30th check starts at t=295 s and hangs
  await clock.tick(5_000); // t=300 s: completion fires, grace begins
  assert.equal(controller.getState().status, 'active');
  assert.equal(controller.getState().lastSession, null);
  await clock.tick(5_000); // t=305 s: the deadline finalizes without the late check
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastSession.completed, true);
  assert.equal(state.lastSession.verifiedSeconds, 285);
  assert.equal(state.lastSession.history.length, 29);
  pending.resolve(result({ countedSeconds: 10 }));
  await flush();
  await clock.tick(10_000);
  const after = controller.getState();
  assert.equal(after.status, 'idle');
  assert.equal(after.checks, 29); // the late result never applied
  assert.equal(after.history.length, 29);
  assert.equal(after.lastSession.verifiedSeconds, 285);
});

test('stopping during the completion grace still records a completed session', async () => {
  const pending = deferred();
  let calls = 0;
  const { controller, clock } = harness({ check: () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(result({ countedSeconds: 5 }));
    if (calls === 30) return pending.promise;
    return Promise.resolve(result({ countedSeconds: 10 }));
  } });
  controller.start({ ...OPTIONS, plannedMinutes: 5 });
  await clock.tick(295_000);
  await clock.tick(5_000); // t=300 s: completion fires, grace begins
  const state = controller.stop();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastSession.completed, true);
  assert.equal(state.lastSession.activeSeconds, 300);
  pending.resolve(result({ countedSeconds: 10 }));
  await flush();
  assert.equal(controller.getState().checks, 29); // the aborted check never applies
});

test('entering error banks the active stretch; error time never counts', async () => {
  const { controller, clock } = harness({ check: async () => { throw new Error('Offline'); } });
  controller.start(OPTIONS);
  await clock.tick(25_000); // three consecutive failures → error at t=25 s
  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.activeSeconds, 25);
  assert.equal(state.activeSince, null);
  await clock.tick(60_000); // time spent in error never counts
  assert.equal(controller.getState().activeSeconds, 25);
  controller.resume();
  assert.equal(controller.getState().activeSince, new Date(85_000).toISOString());
  controller.pause();
  assert.equal(controller.getState().activeSeconds, 25);
  assert.equal(controller.getState().activeSince, null);
  const stopped = controller.stop();
  assert.equal(stopped.lastSession.completed, false);
  assert.equal(stopped.lastSession.activeSeconds, 25);
});
