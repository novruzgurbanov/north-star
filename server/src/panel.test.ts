/**
 * Unit tests for the panel sanitizer and helpers (src/panel.ts). Pure, no server or DB:
 *   npx tsx --test src/panel.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ITEM_ID_RE,
  MAX_WIDGETS,
  WIDGET_ID_RE,
  applyWidgetOp,
  carryProgress,
  cleanText,
  defaultPanel,
  entryMinutes,
  guessProfile,
  keepLogIds,
  parseStoredPanel,
  sameLayout,
  sanitizePanel,
  validateEntryValues,
} from './panel.js';
import { splitInterval } from './points.js';
import { PANEL_PROFILES, type ChecklistWidget, type LogWidget, type PanelSpec, type Widget } from './types.js';

// Every property a widget of each type may carry (anything else must be dropped).
const ALLOWED_KEYS: Record<Widget['type'], string[]> = {
  milestones: ['id', 'title', 'type'],
  focus_session: ['id', 'title', 'type', 'minutes'],
  next_step: ['id', 'title', 'type'],
  log: ['id', 'title', 'type', 'fields', 'proof', 'proofHint'],
  streak: ['id', 'title', 'type', 'source', 'cadence', 'perPeriod'],
  counter: ['id', 'title', 'type', 'source', 'field', 'unit', 'target', 'period'],
  chart: ['id', 'title', 'type', 'source', 'field', 'unit', 'period', 'span'],
  habit_grid: ['id', 'title', 'type', 'source', 'days'],
  checklist: ['id', 'title', 'type', 'items'],
  countdown: ['id', 'title', 'type', 'date', 'label'],
  note: ['id', 'title', 'type', 'text'],
};

/** Structural invariants that must hold for ANY sanitized spec. */
function assertValidSpec(spec: PanelSpec): void {
  assert.ok(spec.widgets.length >= 1 && spec.widgets.length <= MAX_WIDGETS, `1..8 widgets, got ${spec.widgets.length}`);
  assert.ok(PANEL_PROFILES.includes(spec.profile));
  assert.ok(spec.summary.length > 0 && Array.from(spec.summary).length <= 140);
  assert.ok(Number.isInteger(spec.version) && spec.version >= 1);
  const ids = new Set<string>();
  const count = (t: Widget['type']) => spec.widgets.filter((w) => w.type === t).length;
  for (const t of ['milestones', 'focus_session', 'next_step'] as const) assert.ok(count(t) <= 1, `at most one ${t}`);
  assert.ok(count('log') <= 2, 'at most 2 logs');
  const logs = new Map(spec.widgets.filter((w): w is LogWidget => w.type === 'log').map((l) => [l.id, l]));
  for (const w of spec.widgets) {
    assert.match(w.id, WIDGET_ID_RE);
    assert.ok(!ids.has(w.id), `duplicate id ${w.id}`);
    ids.add(w.id);
    const title = Array.from(w.title);
    assert.ok(title.length >= 1 && title.length <= 40, `title length ${title.length}`);
    assert.doesNotMatch(w.title, /[<>\u0000-\u001F]/);
    for (const key of Object.keys(w)) assert.ok(ALLOWED_KEYS[w.type].includes(key), `${w.type} has extra key ${key}`);
    if ('source' in w) {
      const log = logs.get(w.source);
      assert.ok(log, `${w.type} source ${w.source} is a log in the spec`);
      if (w.type === 'counter' || w.type === 'chart') {
        const field = log.fields.find((f) => f.key === w.field);
        assert.ok(field && (field.kind === 'number' || field.kind === 'minutes'), `${w.type} field ${w.field} is numeric`);
      }
    }
    if (w.type === 'focus_session') {
      assert.ok(w.minutes.length >= 1 && w.minutes.length <= 4);
      for (const m of w.minutes) assert.ok(Number.isInteger(m) && m >= 5 && m <= 180);
    }
    if (w.type === 'log') {
      assert.ok(w.fields.length >= 1 && w.fields.length <= 5);
      for (const f of w.fields) {
        assert.match(f.key, /^[a-z][a-z0-9_]{0,23}$/);
        assert.ok(Array.from(f.label).length <= 24 && (f.unit ?? '').length <= 10);
      }
      assert.ok(Array.from(w.proofHint).length <= 80);
    }
    if (w.type === 'checklist') {
      assert.ok(w.items.length >= 1 && w.items.length <= 10);
      for (const item of w.items) assert.match(item.id, ITEM_ID_RE);
    }
    if (w.type === 'note') assert.ok(Array.from(w.text).length <= 400);
    if (w.type === 'streak') assert.ok(w.perPeriod >= 1 && w.perPeriod <= 14);
    if (w.type === 'chart') assert.ok(w.span >= 4 && w.span <= 12);
    if (w.type === 'counter') assert.ok(w.target > 0);
  }
}

const RUN_LOG = {
  type: 'log',
  ref: 'runs',
  title: 'Log a run',
  fields: [
    { key: 'time', label: 'Time', kind: 'minutes', unit: 'min' },
    { key: 'distance', label: 'Distance', kind: 'number', unit: 'km', required: true },
    { key: 'feeling', label: 'Feeling', kind: 'rating' },
    { key: 'where', label: 'Where', kind: 'text' },
  ],
  proof: 'optional',
  proofHint: 'A screenshot of the run',
};

describe('cleanText', () => {
  it('strips HTML, script contents, markdown links and control characters', () => {
    assert.equal(cleanText('<script>alert(1)</script>Hi <b>there</b>', 40), 'Hi there');
    assert.equal(cleanText('[click me](javascript:alert(1)) now', 40), 'click me now');
    assert.equal(cleanText('![img](http://x/y.png)', 40), 'img');
    assert.equal(cleanText('a\u0000b\u0007c\nd‮e', 40), 'a b c de');
    assert.equal(cleanText('<img src=x onerror=alert(1)>ok', 40), 'ok');
    assert.equal(cleanText('1 < 2 > 0', 40), '1 2 0');
  });
  it('drops links that other removals would join, nested links and deeper parens', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const control = String.fromCharCode(1);
    assert.equal(cleanText('[[click](a)](javascript:alert(1))', 80), 'click');
    assert.equal(cleanText(`[click]${zeroWidth}(https://evil.example)`, 80), 'click');
    assert.equal(cleanText('[click]<(https://evil.example)', 80), 'click');
    assert.equal(cleanText(`[click]${control}(https://evil.example)`, 400, true), 'click');
    assert.doesNotMatch(cleanText('[click](javascript:alert((1)))', 80), /\]\(/, 'what is left no longer parses as a link');
    assert.equal(cleanText('Week 1: [plan](http://x) then rest', 400, true), 'Week 1: plan then rest');
  });
  it('caps length (by characters) and handles huge input quickly', () => {
    const started = Date.now();
    const out = cleanText('x'.repeat(5_000_000), 40);
    assert.equal(out.length, 40);
    assert.ok(Date.now() - started < 500, 'huge strings are bounded before regex work');
    assert.equal(Array.from(cleanText('😀'.repeat(100), 10)).length, 10);
  });
  it('keeps newlines only in multiline text', () => {
    assert.equal(cleanText('Week 1: 3 easy runs\nWeek 2: 4 runs', 400, true), 'Week 1: 3 easy runs\nWeek 2: 4 runs');
    assert.equal(cleanText('a\nb', 40), 'a b');
  });
  it('turns non-strings into ""', () => {
    assert.equal(cleanText({ toString: () => 'x' }, 10), '');
    assert.equal(cleanText(null, 10), '');
    assert.equal(cleanText(42, 10), '42');
  });
});

describe('sanitizePanel', () => {
  it('keeps a good AI spec and maps refs to ids', () => {
    const spec = sanitizePanel({
      profile: 'offline',
      summary: 'You log each run.',
      widgets: [
        RUN_LOG,
        { type: 'streak', title: 'Weeks with 3 runs', source: 'runs', cadence: 'weekly', perPeriod: 3 },
        { type: 'counter', title: 'Km this month', source: 'runs', field: 'distance', unit: 'km', target: 60, period: 'month' },
        { type: 'chart', title: 'Km per week', source: 'runs', field: 'Distance', period: 'week', span: 8 },
        { type: 'countdown', title: 'Race day', date: '2027-04-12', label: 'Half marathon' },
      ],
    });
    assertValidSpec(spec);
    assert.equal(spec.profile, 'offline');
    assert.equal(spec.widgets.length, 5);
    const log = spec.widgets[0];
    assert.equal(log.type, 'log');
    for (const w of spec.widgets.slice(1, 4)) assert.equal((w as { source: string }).source, log.id);
    const chart = spec.widgets[3];
    assert.ok(chart.type === 'chart' && chart.field === 'distance' && chart.unit === 'km', 'label match + unit from the field');
  });

  it('survives malicious input: 20 widgets, <script>, unknown types, bad sources, duplicate ids, huge strings', () => {
    const huge = 'A'.repeat(1_000_000);
    const widgets: unknown[] = [
      { type: 'note', id: 'w_dup1', title: '<script>steal()</script>Plan', text: `<iframe src="evil"></iframe>${huge}`, onClick: 'alert(1)' },
      { type: 'note', id: 'w_dup1', title: 'Second note same id', text: 'ok' },
      { type: 'iframe', title: 'bad', src: 'https://evil.example' },
      { type: 'script', title: 'bad', code: 'process.exit()' },
      { type: '__proto__', title: 'bad' },
      { type: 'streak', title: 'Orphan streak', source: 'w_missing', cadence: 'daily', perPeriod: 1 },
      { type: 'counter', title: 'Text field counter', source: 'runs', field: 'where', unit: 'x', target: 5, period: 'week' },
      { type: 'counter', title: 'No target', source: 'runs', field: 'distance', unit: 'km', target: -1, period: 'week' },
      { type: 'chart', title: 'Unknown field', source: 'runs', field: 'pace', period: 'week', span: 99 },
      { type: 'milestones', title: 'M1' },
      { type: 'milestones', title: 'M2' },
      { type: 'focus_session', title: 'F1', minutes: [1, 999, 'x', 25, 25, 50, 90, 120] },
      { type: 'focus_session', title: 'F2', minutes: [25] },
      { ...RUN_LOG, id: 'not-an-id', title: huge },
      { ...RUN_LOG, ref: 'second', title: 'Second log' },
      { ...RUN_LOG, ref: 'third', title: 'Third log' },
      { type: 'habit_grid', title: 'Grid', source: 'runs', days: 3 },
      { type: 'checklist', title: 'Gear', items: Array.from({ length: 25 }, (_, i) => ({ id: 'i_same', text: `Item ${i} <b>x</b>`, done: 'yes' })) },
      { type: 'countdown', title: 'Bad date', date: '2027-02-30', label: 'x' },
      { type: 'next_step', title: 'Next' },
    ];
    assert.equal(widgets.length, 20);
    const spec = sanitizePanel({ profile: 'hacker', summary: `<a href="x">${huge}</a>`, widgets, extra: 'dropped' });
    assertValidSpec(spec);
    assert.ok(spec.widgets.length <= MAX_WIDGETS);
    assert.ok(!('extra' in spec));
    const types = spec.widgets.map((w) => w.type);
    for (const bad of ['iframe', 'script', '__proto__']) assert.ok(!types.includes(bad as Widget['type']));
    const notes = spec.widgets.filter((w) => w.type === 'note');
    assert.equal(notes[0]?.title, 'Plan', 'script stripped from the title');
    assert.equal(new Set(spec.widgets.map((w) => w.id)).size, spec.widgets.length, 'ids unique');
    assert.equal(notes[0]?.id, 'w_dup1', 'the first holder keeps a valid id');
    assert.notEqual(notes[1]?.id, 'w_dup1', 'the duplicate gets a fresh id');
    assert.ok(!spec.widgets.some((w) => w.title === 'Orphan streak' || w.title === 'Text field counter' || w.title === 'No target' || w.title === 'Unknown field'));
    assert.ok(Array.from(spec.summary).length <= 140 && !spec.summary.includes('<'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('enforces the 2-log limit and drops dependents of a dropped log', () => {
    const spec = sanitizePanel({
      widgets: [
        { ...RUN_LOG, ref: 'a', title: 'A' },
        { ...RUN_LOG, ref: 'b', title: 'B' },
        { ...RUN_LOG, ref: 'c', title: 'C' },
        { type: 'streak', title: 'Streak on C', source: 'c' },
        { type: 'streak', title: 'Streak on B', source: 'b' },
      ],
    });
    assertValidSpec(spec);
    assert.deepEqual(
      spec.widgets.map((w) => w.title),
      ['A', 'B', 'Streak on B']
    );
  });

  it('drops widgets whose log falls beyond the 8-widget cap', () => {
    const spec = sanitizePanel({
      widgets: [
        { type: 'streak', title: 'Streak first', source: 'late' },
        ...Array.from({ length: 7 }, (_, i) => ({ type: 'note', title: `Note ${i}`, text: 'x' })),
        { ...RUN_LOG, ref: 'late', title: 'Late log' },
      ],
    });
    assertValidSpec(spec);
    assert.ok(!spec.widgets.some((w) => w.type === 'streak' || w.type === 'log'));
  });

  it('extra properties are dropped from widgets, fields and items', () => {
    const spec = sanitizePanel(
      JSON.parse(
        '{"widgets":[{"type":"log","title":"L","fields":[{"key":"km","label":"Km","kind":"number","style":"x","__proto__":{"polluted":1}}],"proof":"none","proofHint":"ignored","dangerouslySetInnerHTML":{"__html":"<b>x</b>"}},' +
          '{"type":"checklist","title":"C","items":[{"text":"Buy shoes","done":true,"href":"x"}]}]}'
      )
    );
    assertValidSpec(spec);
    const log = spec.widgets[0] as LogWidget;
    assert.deepEqual(Object.keys(log.fields[0]).sort(), ['key', 'kind', 'label']);
    assert.equal(log.proofHint, '', 'no hint when proof is none');
    const list = spec.widgets[1];
    assert.ok(list.type === 'checklist');
    assert.deepEqual(Object.keys(list.items[0]).sort(), ['done', 'id', 'text']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('falls back to the default panel when nothing valid is left', () => {
    for (const raw of [null, 'x', [], 42, {}, { widgets: [{ type: 'nope' }, { type: 'streak', source: 'x' }] }]) {
      const spec = sanitizePanel(raw, { fallbackProfile: 'habit' });
      assertValidSpec(spec);
      assert.equal(spec.profile, 'habit');
      assert.ok(spec.widgets.some((w) => w.type === 'habit_grid'));
    }
    assert.equal(sanitizePanel({ widgets: [] }, { fallback: false }), null);
  });

  it('re-assigns a kept id whose widget type changed (entries stay with their log)', () => {
    const before = sanitizePanel({ widgets: [RUN_LOG, { type: 'milestones', title: 'M' }] });
    const logId = before.widgets[0].id;
    const after = sanitizePanel(
      { widgets: [{ type: 'note', id: logId, title: 'Hijack', text: 'x' }, { ...RUN_LOG, id: logId }] },
      { previous: before }
    );
    assertValidSpec(after);
    assert.notEqual(after.widgets[0].id, logId);
    assert.equal(after.widgets[1].id, logId, 'the log keeps its id');
  });

  it('profile is inferred when missing, and per-type limits are clamped', () => {
    const spec = sanitizePanel({
      widgets: [
        { type: 'focus_session', minutes: 'abc' },
        { type: 'milestones' },
        { ...RUN_LOG, ref: 'r' },
        { type: 'streak', source: 'r', cadence: 'sometimes', perPeriod: 99 },
        { type: 'chart', source: 'r', field: 'time', span: 2 },
      ],
    });
    assertValidSpec(spec);
    assert.equal(spec.profile, 'mixed');
    const [focus, ms, , streak, chart] = spec.widgets;
    assert.ok(focus.type === 'focus_session' && focus.minutes[0] === 25 && focus.title === 'Focus session');
    assert.equal(ms.title, 'Milestones');
    assert.ok(streak.type === 'streak' && streak.cadence === 'weekly' && streak.perPeriod === 14);
    assert.ok(chart.type === 'chart' && chart.span === 4 && chart.unit === 'min');
  });

  it('a counter target that rounds to 0 is no target', () => {
    const counter = (target: number) =>
      sanitizePanel({ widgets: [{ ...RUN_LOG }, { type: 'counter', source: 'runs', field: 'distance', target }] }).widgets.find(
        (w) => w.type === 'counter'
      );
    assert.equal(counter(0.004), undefined);
    assert.ok(counter(0.005)?.type === 'counter' && counter(0.005)?.target === 0.01);
  });

  it('checklist ticks come from the current spec, never from the AI', () => {
    const base = sanitizePanel({ widgets: [{ type: 'checklist', title: 'Gear', items: ['Shoes', 'Watch'] }] });
    const list = base.widgets[0] as ChecklistWidget;
    const [shoes, watch] = list.items;
    const ticked = applyWidgetOp(base, list.id, { kind: 'toggle_item', itemId: shoes.id });
    assert.ok(ticked.ok);
    // The AI un-ticks Shoes, re-emits Watch without its id but ticked, and adds a ticked item.
    const ai = {
      widgets: [
        {
          type: 'checklist',
          id: list.id,
          title: 'Gear',
          items: [
            { id: shoes.id, text: 'Shoes', done: false },
            { text: 'watch', done: true },
            { text: 'Race bib', done: true },
          ],
        },
      ],
    };
    const next = sanitizePanel(ai, { previous: ticked.spec, progress: ticked.spec });
    assertValidSpec(next);
    const items = (next.widgets[0] as ChecklistWidget).items;
    assert.deepEqual(
      items.map((i) => [i.text, i.done]),
      [['Shoes', true], ['watch', false], ['Race bib', false]]
    );
    assert.equal(items[0].id, shoes.id);
    assert.equal(items[1].id, watch.id, 'the same text keeps the old id');
    assert.ok(![shoes.id, watch.id].includes(items[2].id));
    const designed = sanitizePanel({ widgets: [{ type: 'checklist', items: [{ text: 'A', done: true }] }] }, { progress: null });
    assert.equal((designed.widgets[0] as ChecklistWidget).items[0].done, false, 'a fresh design starts undone');
    const stored = sanitizePanel({ widgets: [{ type: 'checklist', items: [{ text: 'A', done: true }] }] });
    assert.equal((stored.widgets[0] as ChecklistWidget).items[0].done, true, 'stored specs keep their ticks');
  });

  it('undo keeps the ticks made since; sameLayout ignores ticks only', () => {
    const v1 = sanitizePanel({ widgets: [{ type: 'checklist', title: 'Gear', items: ['Shoes', 'Watch'] }, { type: 'milestones' }] });
    const list = v1.widgets[0] as ChecklistWidget;
    const removed = applyWidgetOp(v1, v1.widgets[1].id, { kind: 'remove' });
    assert.ok(removed.ok);
    const ticked = applyWidgetOp(removed.spec, list.id, { kind: 'toggle_item', itemId: list.items[1].id });
    assert.ok(ticked.ok);
    const restored = carryProgress(v1, ticked.spec);
    assert.deepEqual(restored.widgets.map((w) => w.type), ['checklist', 'milestones']);
    assert.deepEqual((restored.widgets[0] as ChecklistWidget).items.map((i) => i.done), [false, true]);
    assert.equal((v1.widgets[0] as ChecklistWidget).items[1].done, false, 'pure: input spec unchanged');
    assert.ok(sameLayout(removed.spec, ticked.spec));
    assert.ok(!sameLayout(v1, ticked.spec));
    assert.ok(sameLayout(null, null) && !sameLayout(v1, null));
  });

  it('a re-made log that records the same things takes the old log id; its widgets follow', () => {
    const before = sanitizePanel({ widgets: [RUN_LOG, { type: 'streak', title: 'S', source: 'runs' }] });
    const oldId = before.widgets[0].id;
    const after = sanitizePanel(
      {
        widgets: [
          { type: 'log', ref: 'swims', title: 'Swims', fields: [{ key: 'laps', label: 'Laps', kind: 'number' }] },
          { ...RUN_LOG, ref: 'again', title: 'Log a run' },
          { type: 'counter', title: 'Km', source: 'again', field: 'distance', target: 50 },
        ],
      },
      { previous: before }
    );
    const kept = keepLogIds(after, before);
    assertValidSpec(kept);
    assert.notEqual(kept.widgets[0].id, oldId, 'no shared field: a new log');
    assert.equal(kept.widgets[1].id, oldId);
    assert.ok(kept.widgets[2].type === 'counter' && kept.widgets[2].source === oldId);
    assert.equal(keepLogIds(before, before), before, 'a log kept by id is left alone');
  });

  it('stored panels parse back with the same ids; corrupt ones become null', () => {
    const spec = defaultPanel('offline');
    const back = parseStoredPanel(JSON.stringify(spec));
    assert.deepEqual(back, spec);
    assert.equal(parseStoredPanel('{not json'), null);
    assert.equal(parseStoredPanel(undefined), null);
  });
});

describe('default panels and profile guesses', () => {
  it('every profile has a valid default panel', () => {
    for (const profile of PANEL_PROFILES) {
      const spec = defaultPanel(profile);
      assertValidSpec(spec);
      assert.equal(spec.profile, profile);
    }
    assert.ok(!defaultPanel('offline').widgets.some((w) => w.type === 'focus_session'));
    assert.ok(defaultPanel('screen').widgets.some((w) => w.type === 'focus_session'));
  });
  it('guesses a profile from the goal words', () => {
    assert.equal(guessProfile('Run my first marathon').profile, 'offline');
    assert.equal(guessProfile('Run my first marathon').hint.unit, 'km');
    assert.equal(guessProfile('Finish my master thesis').profile, 'screen');
    assert.equal(guessProfile('Meditate every day').profile, 'habit');
    assert.equal(guessProfile('Read 20 books this year').profile, 'quantity');
    assert.equal(guessProfile('Something vague').profile, 'mixed');
  });
});

describe('applyWidgetOp', () => {
  const base = sanitizePanel({
    widgets: [
      RUN_LOG,
      { type: 'streak', title: 'S', source: 'runs' },
      { type: 'checklist', title: 'Gear', items: ['Shoes', 'Watch'] },
      { type: 'milestones', title: 'M' },
    ],
  });
  it('moves a widget (clamped) and bumps the version', () => {
    const last = base.widgets[3].id;
    const r = applyWidgetOp(base, last, { kind: 'move', to: -5 });
    assert.ok(r.ok);
    assert.equal(r.spec.widgets[0].id, last);
    assert.equal(r.spec.version, base.version + 1);
    const r2 = applyWidgetOp(base, base.widgets[0].id, { kind: 'move', to: 99 });
    assert.ok(r2.ok && r2.spec.widgets[3].id === base.widgets[0].id);
  });
  it('removing a log also removes what depends on it', () => {
    const r = applyWidgetOp(base, base.widgets[0].id, { kind: 'remove' });
    assert.ok(r.ok);
    assert.deepEqual(r.spec.widgets.map((w) => w.type), ['checklist', 'milestones']);
  });
  it('toggles a checklist item without touching the original', () => {
    const list = base.widgets[2];
    assert.ok(list.type === 'checklist');
    const r = applyWidgetOp(base, list.id, { kind: 'toggle_item', itemId: list.items[1].id });
    assert.ok(r.ok);
    const after = r.spec.widgets[2];
    assert.ok(after.type === 'checklist' && after.items[1].done === true && after.items[0].done === false);
    assert.equal(list.items[1].done, false, 'pure: input spec unchanged');
  });
  it('errors: unknown widget 404, item on a non-checklist 400, unknown item 404, last widget 409', () => {
    assert.deepEqual(applyWidgetOp(base, 'w_nope1234', { kind: 'remove' }), { ok: false, status: 404, error: 'widget not found' });
    const r1 = applyWidgetOp(base, base.widgets[0].id, { kind: 'toggle_item', itemId: 'i_x' });
    assert.ok(!r1.ok && r1.status === 400);
    const r2 = applyWidgetOp(base, base.widgets[2].id, { kind: 'toggle_item', itemId: 'i_nothere' });
    assert.ok(!r2.ok && r2.status === 404);
    const single = sanitizePanel({ widgets: [{ type: 'milestones' }] });
    const r3 = applyWidgetOp(single, single.widgets[0].id, { kind: 'remove' });
    assert.ok(!r3.ok && r3.status === 409);
  });
});

describe('entries', () => {
  const log = sanitizePanel({ widgets: [RUN_LOG] }).widgets[0] as LogWidget;
  it('accepts valid values and drops unknown keys', () => {
    const r = validateEntryValues(log, { time: 34, distance: '6.2', feeling: 4, where: 'Park', hacker: 1 });
    assert.deepEqual(r, { ok: true, values: { time: 34, distance: 6.2, feeling: 4, where: 'Park' } });
  });
  it('rejects bad values in strict mode', () => {
    const bad: Array<Record<string, unknown>> = [
      { distance: -1 },
      { distance: 100_001 },
      { distance: 'five' },
      { distance: 5, feeling: 6 },
      { distance: 5, feeling: 2.5 },
      { distance: 5, where: 'x'.repeat(121) },
      { time: 30 }, // distance is required
      { distance: true },
    ];
    for (const values of bad) assert.equal(validateEntryValues(log, values).ok, false, JSON.stringify(values).slice(0, 60));
    assert.equal(validateEntryValues(log, 'nope').ok, false);
    assert.equal(validateEntryValues(log, { constructor: 1, distance: 3 }).ok, true);
  });
  it('lenient mode (the coach) coerces "5 km" and drops bad optional values', () => {
    const r = validateEntryValues(log, { distance: '5 km', time: '31 min', feeling: 'great', where: 'x'.repeat(300) }, true);
    assert.ok(r.ok);
    assert.deepEqual(r.values, { time: 31, distance: 5, where: 'x'.repeat(120) });
  });
  it('lenient numbers: thousands separators are thousands, a lone comma is a decimal point', () => {
    const value = (distance: string) => {
      const r = validateEntryValues(log, { distance }, true);
      return r.ok ? r.values.distance : null;
    };
    assert.equal(value('1,500'), 1500);
    assert.equal(value('1,500 m'), 1500);
    assert.equal(value('12,345.6'), 12345.6);
    assert.equal(value('1 500 m'), 1500);
    assert.equal(value('5,2 km'), 5.2);
    assert.equal(value('6.2km'), 6.2);
  });
  it('an entry needs at least one value, in both modes', () => {
    const habit = defaultPanel('habit').widgets[0] as LogWidget;
    for (const lenient of [false, true]) {
      assert.deepEqual(validateEntryValues(habit, {}, lenient), { ok: false, error: 'log at least one value' });
      assert.equal(validateEntryValues(habit, { done: null }, lenient).ok, false);
      assert.equal(validateEntryValues(habit, { done: true }, lenient).ok, true);
    }
    const noted = sanitizePanel({ widgets: [{ type: 'log', fields: [{ key: 'where', label: 'Where', kind: 'text' }] }] }).widgets[0] as LogWidget;
    assert.equal(validateEntryValues(noted, { where: '<b></b>' }).ok, false, 'text that cleans down to nothing is no value');
  });
  it('minutes = the first minutes field, capped at 600', () => {
    assert.equal(entryMinutes(log, { time: 34, distance: 6 }), 34);
    assert.equal(entryMinutes(log, { time: 5000, distance: 6 }), 600);
    assert.equal(entryMinutes(log, { distance: 6 }), 0);
  });
});

describe('splitInterval', () => {
  it('splits into back-to-back chunks of at most 15 minutes ending at the entry time', () => {
    const end = '2026-10-17T08:00:00.000Z';
    const chunks = splitInterval(end, 34);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].start, '2026-10-17T07:26:00.000Z');
    assert.equal(chunks[chunks.length - 1].end, end);
    for (let i = 0; i < chunks.length; i++) {
      const len = Date.parse(chunks[i].end) - Date.parse(chunks[i].start);
      assert.ok(len > 0 && len <= 15 * 60_000);
      if (i > 0) assert.equal(chunks[i].start, chunks[i - 1].end);
    }
    assert.deepEqual(splitInterval(end, 0), []);
    assert.equal(splitInterval(end, 15).length, 1);
  });
  it('splits evenly, so no chunk is under 5 s; under 5 s in total is not reported', () => {
    const end = '2026-10-17T08:00:00.000Z';
    for (const minutes of [15.05, 30.01, 45.02, 0.09, 600]) {
      const chunks = splitInterval(end, minutes);
      const lengths = chunks.map((c) => Date.parse(c.end) - Date.parse(c.start));
      assert.equal(chunks[chunks.length - 1].end, end);
      assert.equal(lengths.reduce((a, b) => a + b, 0), Math.round(minutes * 60_000), `${minutes} min in total`);
      for (const len of lengths) assert.ok(len >= 5_000 && len <= 15 * 60_000, `${minutes} min: chunk of ${len} ms`);
    }
    assert.equal(splitInterval(end, 15.05).length, 2);
    assert.deepEqual(splitInterval(end, 0.08), [], '4.8 s');
  });
});
