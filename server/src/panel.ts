/**
 * AI-built goal panels (../../PANELS.md): the strict sanitizer every spec goes
 * through (AI-written or client-sent), the default panels, manual widget edits
 * and entry validation. Pure functions only (no I/O), so src/panel.test.ts can
 * check them directly. A spec is never executed; it only selects and configures
 * built-in widgets.
 */
import { customAlphabet } from 'nanoid';
import {
  PANEL_PROFILES,
  type ChecklistItem,
  type Entry,
  type Field,
  type FieldKind,
  type LogWidget,
  type PanelProfile,
  type PanelSpec,
  type ProofMode,
  type Widget,
  type WidgetType,
} from './types.js';

const shortId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

export const WIDGET_ID_RE = /^w_[a-z0-9]{4,12}$/;
export const ITEM_ID_RE = /^i_[a-z0-9]{4,12}$/;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/; // snake_case, 1-24 chars

export const MAX_WIDGETS = 8;
const MAX_RAW_WIDGETS = 32; // never walk further into a huge array
const MAX_LOGS = 2;
const SINGLETONS: ReadonlySet<WidgetType> = new Set<WidgetType>(['milestones', 'focus_session', 'next_step']);
const WIDGET_TYPES: readonly WidgetType[] = [
  'milestones',
  'focus_session',
  'next_step',
  'log',
  'streak',
  'counter',
  'chart',
  'habit_grid',
  'checklist',
  'countdown',
  'note',
];
const FIELD_KINDS: readonly FieldKind[] = ['number', 'minutes', 'text', 'rating', 'boolean'];
const PROOF_MODES: readonly ProofMode[] = ['none', 'optional', 'required'];

/** Used when the AI (or a client) leaves a title empty. */
const DEFAULT_TITLES: Record<WidgetType, string> = {
  milestones: 'Milestones',
  focus_session: 'Focus session',
  next_step: 'Next step',
  log: 'Log it',
  streak: 'Streak',
  counter: 'Total',
  chart: 'Progress',
  habit_grid: 'Habit grid',
  checklist: 'Checklist',
  countdown: 'Countdown',
  note: 'Note',
};

const DEFAULT_SUMMARIES: Record<PanelProfile, string> = {
  screen: 'You work on this at your computer: pick the next step and focus on it.',
  project: 'You build this step by step: tick off milestones and focus on the next one.',
  offline: 'You log each session away from the screen; a few a week keeps it moving.',
  habit: 'You check in each day you do it; the grid and streak show the rhythm.',
  quantity: 'You log how much you did each time and watch the total grow.',
  mixed: 'Some of this happens at your computer and some away from it; track both here.',
};

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

// Zero-width, bidi-mark/override/isolate and BOM characters: invisible, never wanted in a label.
const INVISIBLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// A markdown link or image, with one level of parens inside the URL.
const MD_LINK_RE = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;

/**
 * Plain text only: drops HTML tags (and script/style contents), turns markdown
 * links into their text, removes control and invisible characters, collapses
 * whitespace, trims and caps at `max` characters. Non-strings become "".
 */
export function cleanText(raw: unknown, max: number, multiline = false): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  let s = String(raw).slice(0, max * 4 + 200); // bound the regex work on huge strings
  s = s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?[a-z!?][^>]*>/gi, ' ')
    .replace(/[<>]/g, '')
    .replace(INVISIBLE_RE, '');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  // Links last: every removal above can join a new "[text](url)", and a nested link
  // unwraps one level per pass (each pass shortens the string, so this ends).
  let before: string;
  do {
    before = s;
    s = s.replace(MD_LINK_RE, '$1');
  } while (s !== before);
  s = s.replace(/\]\(/g, '] (').replace(/\]\[/g, '] ['); // leftovers (deeper parens) no longer parse as links
  s = multiline
    ? s.replace(/[ \u00A0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ');
  return Array.from(s.trim()).slice(0, max).join('').trim();
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function finiteNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = finiteNumber(raw);
  if (n === null) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** "Distance (km)" -> "distance_km"; "" when nothing latin is left. */
function toFieldKey(s: string): string {
  let key = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (/^[0-9]/.test(key)) key = `f_${key}`;
  return key.slice(0, 24).replace(/_+$/, '');
}

function keyToLabel(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 24);
}

function freshId(prefix: 'w_' | 'i_', used: Set<string>): string {
  let id = `${prefix}${shortId()}`;
  while (used.has(id)) id = `${prefix}${shortId()}`;
  used.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Widget parsing (per-type limits; sources are resolved later, per spec)
// ---------------------------------------------------------------------------

type Draft = {
  widget: Widget;
  rawId: string | null; // the id it came with (kept when valid and unused)
  ref: string | null; // the AI's temporary name for a log ("runs")
  source: string | null; // raw source reference (id or ref) for streak/counter/chart/habit_grid
  field: string | null; // raw field reference for counter/chart
};

function parseFields(raw: unknown): Field[] {
  if (!Array.isArray(raw)) return [];
  const out: Field[] = [];
  const keys = new Set<string>();
  for (const item of raw.slice(0, 20)) {
    const o = asObject(item);
    if (!o) continue;
    const kind = pick<FieldKind | ''>(o.kind, FIELD_KINDS, '');
    if (!kind) continue;
    const label = cleanText(o.label, 24);
    let key = typeof o.key === 'string' ? o.key.trim().toLowerCase() : '';
    if (!FIELD_KEY_RE.test(key)) key = toFieldKey(key || label);
    if (!key) key = `field_${out.length + 1}`;
    if (keys.has(key)) continue;
    const field: Field = { key, label: label || keyToLabel(key), kind };
    const unit = cleanText(o.unit, 10);
    if (unit && (kind === 'number' || kind === 'minutes')) field.unit = unit;
    if (o.required === true) field.required = true;
    keys.add(key);
    out.push(field);
    if (out.length === 5) break;
  }
  return out;
}

/** Checklist progress a new spec must keep: the earlier spec's items by id and by text. */
type Progress = {
  byId: Map<string, ChecklistItem>;
  byText: Map<string, ChecklistItem>; // lowercased text -> the first item with it
  claimed: Set<string>; // earlier ids that some raw item names itself, so no text match takes them
};

const textKey = (text: string): string => text.toLowerCase();

function checklistItems(spec: PanelSpec | null): ChecklistItem[] {
  return (spec?.widgets ?? []).flatMap((w) => (w.type === 'checklist' ? w.items : []));
}

function progressOf(spec: PanelSpec | null, rawWidgets: unknown[]): Progress {
  const byId = new Map<string, ChecklistItem>();
  const byText = new Map<string, ChecklistItem>();
  for (const item of checklistItems(spec)) {
    byId.set(item.id, item);
    if (!byText.has(textKey(item.text))) byText.set(textKey(item.text), item);
  }
  const claimed = new Set<string>();
  for (const rw of rawWidgets) {
    const items = asObject(rw)?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 30)) {
      const id = asObject(item)?.id;
      if (typeof id === 'string' && byId.has(id)) claimed.add(id);
    }
  }
  return { byId, byText, claimed };
}

/**
 * Checklist items, at most 10. With `progress`, ticks are the user's, never the AI's: an
 * item takes `done` from the earlier item with its id, else from the one with its text
 * (and that item's id, so it stays the same item); a genuinely new item starts undone.
 */
function parseItems(raw: unknown, usedItemIds: Set<string>, progress: Progress | null): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  for (const item of raw.slice(0, 30)) {
    const o = asObject(item);
    const text = cleanText(o ? o.text : item, 60);
    if (!text) continue;
    const rawId = o && typeof o.id === 'string' ? o.id : '';
    let id = ITEM_ID_RE.test(rawId) && !usedItemIds.has(rawId) ? rawId : '';
    let done = o?.done === true;
    if (progress) {
      let before = id ? progress.byId.get(id) : undefined;
      if (!before) {
        const same = progress.byText.get(textKey(text));
        if (same && !usedItemIds.has(same.id) && !progress.claimed.has(same.id)) {
          before = same;
          id = same.id;
        }
      }
      done = before?.done ?? false;
    }
    if (id) usedItemIds.add(id);
    else id = freshId('i_', usedItemIds);
    out.push({ id, text, done });
    if (out.length === 10) break;
  }
  return out;
}

/** A real calendar date YYYY-MM-DD between 1970 and 2200, else null. */
function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2200) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? s : null;
}

function parseMinutesList(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: number[] = [];
  for (const v of list.slice(0, 10)) {
    const n = finiteNumber(v);
    if (n === null) continue;
    const m = Math.max(5, Math.min(180, Math.round(n)));
    if (!out.includes(m)) out.push(m);
    if (out.length === 4) break;
  }
  return out.length > 0 ? out : [25];
}

function rawRef(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim().slice(0, 40);
  return s || null;
}

/** One raw widget -> a draft with only known properties, or null when it is invalid. */
function parseWidget(raw: unknown, usedItemIds: Set<string>, progress: Progress | null): Draft | null {
  const o = asObject(raw);
  if (!o) return null;
  const type = pick<WidgetType | ''>(o.type, WIDGET_TYPES, '');
  if (!type) return null;
  const title = cleanText(o.title, 40) || DEFAULT_TITLES[type];
  const draft = (widget: Widget, extra: Partial<Draft> = {}): Draft => ({
    widget,
    rawId: typeof o.id === 'string' ? o.id : null,
    ref: rawRef(o.ref),
    source: null,
    field: null,
    ...extra,
  });
  const source = rawRef(o.source);
  switch (type) {
    case 'milestones':
    case 'next_step':
      return draft({ id: '', title, type });
    case 'focus_session':
      return draft({ id: '', title, type, minutes: parseMinutesList(o.minutes) });
    case 'log': {
      const fields = parseFields(o.fields);
      if (fields.length === 0) return null;
      const proof = pick<ProofMode>(o.proof, PROOF_MODES, 'optional');
      const proofHint = proof === 'none' ? '' : cleanText(o.proofHint, 80);
      return draft({ id: '', title, type, fields, proof, proofHint });
    }
    case 'streak': {
      const cadence = pick(o.cadence, ['daily', 'weekly'] as const, 'weekly');
      const perPeriod = clampInt(o.perPeriod, 1, 14, cadence === 'daily' ? 1 : 3);
      return draft({ id: '', title, type, source: '', cadence, perPeriod }, { source });
    }
    case 'counter': {
      const raw = finiteNumber(o.target);
      const target = raw === null ? null : Math.min(1_000_000, Math.round(raw * 100) / 100);
      if (target === null || target <= 0) return null; // checked after rounding: 0.004 is no target
      const period = pick(o.period, ['week', 'month', 'total'] as const, 'week');
      const widget: Widget = { id: '', title, type, source: '', field: '', unit: cleanText(o.unit, 10), target, period };
      return draft(widget, { source, field: rawRef(o.field) });
    }
    case 'chart': {
      const period = pick(o.period, ['week', 'month'] as const, 'week');
      const span = clampInt(o.span, 4, 12, 8);
      const widget: Widget = { id: '', title, type, source: '', field: '', unit: cleanText(o.unit, 10), period, span };
      return draft(widget, { source, field: rawRef(o.field) });
    }
    case 'habit_grid': {
      const n = finiteNumber(o.days);
      const days: 14 | 28 = n !== null && n <= 21 ? 14 : 28;
      return draft({ id: '', title, type, source: '', days }, { source });
    }
    case 'checklist': {
      const items = parseItems(o.items, usedItemIds, progress);
      if (items.length === 0) return null;
      return draft({ id: '', title, type, items });
    }
    case 'countdown': {
      const date = parseDate(o.date);
      if (!date) return null;
      return draft({ id: '', title, type, date, label: cleanText(o.label, 40) });
    }
    case 'note': {
      const text = cleanText(o.text, 400, true);
      if (!text) return null;
      return draft({ id: '', title, type, text });
    }
  }
}

/** The log's number/minutes field named by `raw` (key, then key/label ignoring case); the only one when `raw` is empty. */
function resolveField(log: LogWidget, raw: string | null): Field | null {
  const numeric = log.fields.filter((f) => f.kind === 'number' || f.kind === 'minutes');
  if (!raw) return numeric.length === 1 ? numeric[0] : null;
  const exact = numeric.find((f) => f.key === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  return numeric.find((f) => f.key === lower || f.label.toLowerCase() === lower) ?? null;
}

/** A guess at the profile from the widgets, when the spec does not name a valid one. */
function inferProfile(widgets: Widget[]): PanelProfile {
  const has = (t: WidgetType) => widgets.some((w) => w.type === t);
  if (has('focus_session') && has('log')) return 'mixed';
  if (has('focus_session')) return 'screen';
  if (has('habit_grid')) return 'habit';
  if ((has('counter') || has('chart')) && !has('streak')) return 'quantity';
  if (has('log')) return 'offline';
  return 'project';
}

// ---------------------------------------------------------------------------
// sanitizePanel: the one door every spec goes through
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** Profile used when the spec names none (and for the default panel). */
  fallbackProfile?: PanelProfile;
  /** The spec this one replaces: a kept id must keep its widget type, so entries stay attached. */
  previous?: PanelSpec | null;
  /**
   * For AI-written specs: checklist ticks come from this spec (item id, else item text),
   * never from the raw spec; new items start undone (null: every item does). Omitted, the
   * raw `done` flags are kept (stored specs, manual edits).
   */
  progress?: PanelSpec | null;
  /** Number field used by the default panel (see guessProfile). */
  hint?: FieldHint;
  version?: number;
  updatedAt?: string;
  /** false: return null instead of the default panel when no valid widget is left. */
  fallback?: boolean;
}

/**
 * Enforce every rule in PANELS.md section 1 on any spec: at most 8 widgets; at most
 * one each of milestones, focus_session and next_step; at most 2 logs; sources must
 * name a log in the same spec (temporary `ref`s are mapped to ids); counter/chart
 * fields must be number or minutes fields of that log; unknown types and extra
 * properties are dropped; text is cleaned and capped; bad or duplicate ids are
 * re-assigned. An invalid widget is dropped, not the whole spec; when nothing valid
 * is left, the default panel for the profile is returned (or null with fallback: false).
 */
export function sanitizePanel(raw: unknown, opts?: SanitizeOptions & { fallback?: true }): PanelSpec;
export function sanitizePanel(raw: unknown, opts: SanitizeOptions & { fallback: false }): PanelSpec | null;
export function sanitizePanel(raw: unknown, opts: SanitizeOptions = {}): PanelSpec | null {
  const o = asObject(raw) ?? {};
  const rawWidgets = Array.isArray(o.widgets) ? o.widgets.slice(0, MAX_RAW_WIDGETS) : [];
  const usedItemIds = new Set<string>();
  const progress = opts.progress === undefined ? null : progressOf(opts.progress, rawWidgets);

  // 1. Parse each widget; first one wins for the singletons, at most 2 logs.
  const drafts: Draft[] = [];
  const counts = new Map<WidgetType, number>();
  for (const rw of rawWidgets) {
    const d = parseWidget(rw, usedItemIds, progress);
    if (!d) continue;
    const type = d.widget.type;
    const count = counts.get(type) ?? 0;
    if (SINGLETONS.has(type) && count >= 1) continue;
    if (type === 'log' && count >= MAX_LOGS) continue;
    counts.set(type, count + 1);
    drafts.push(d);
  }

  // 2. Ids: keep a well-formed, unused id that kept its type; re-assign the rest.
  const previousTypes = new Map((opts.previous?.widgets ?? []).map((w) => [w.id, w.type] as const));
  const usedIds = new Set<string>();
  const keepsId = (d: Draft): boolean => {
    const id = d.rawId;
    if (!id || !WIDGET_ID_RE.test(id) || usedIds.has(id)) return false;
    const before = previousTypes.get(id);
    return before === undefined || before === d.widget.type;
  };
  const pending: Draft[] = [];
  for (const d of drafts) {
    if (keepsId(d)) {
      d.widget.id = d.rawId as string;
      usedIds.add(d.widget.id);
    } else pending.push(d);
  }
  for (const d of pending) d.widget.id = freshId('w_', usedIds);

  // 3. Logs by id, and by the ref (or malformed id) they came with.
  const logs = new Map<string, LogWidget>();
  const aliases = new Map<string, string>();
  for (const d of drafts) {
    if (d.widget.type !== 'log') continue;
    logs.set(d.widget.id, d.widget);
    for (const alias of [d.ref, d.rawId]) if (alias && !aliases.has(alias)) aliases.set(alias, d.widget.id);
  }

  // 4. Resolve sources and fields; drop widgets that point nowhere valid.
  const resolved: Widget[] = [];
  for (const d of drafts) {
    const w = d.widget;
    if (w.type === 'streak' || w.type === 'habit_grid' || w.type === 'counter' || w.type === 'chart') {
      const ref = d.source ?? '';
      const logId = logs.has(ref) ? ref : aliases.get(ref);
      const log = logId ? logs.get(logId) : undefined;
      if (!log) continue;
      w.source = log.id;
      if (w.type === 'counter' || w.type === 'chart') {
        const field = resolveField(log, d.field);
        if (!field) continue;
        w.field = field.key;
        if (!w.unit) w.unit = field.unit ?? (field.kind === 'minutes' ? 'min' : '');
      }
    }
    resolved.push(w);
  }

  // 5. At most 8; a widget whose log fell off the end goes too.
  const capped = resolved.slice(0, MAX_WIDGETS);
  const keptLogs = new Set(capped.filter((w) => w.type === 'log').map((w) => w.id));
  const widgets = capped.filter((w) => !('source' in w) || keptLogs.has(w.source));

  const profile = pick<PanelProfile | ''>(o.profile, PANEL_PROFILES, '') || opts.fallbackProfile || inferProfile(widgets);
  const rawVersion = finiteNumber(o.version);
  const version = opts.version ?? (rawVersion !== null && rawVersion >= 1 ? Math.floor(rawVersion) : 1);
  const updatedAt =
    opts.updatedAt ??
    (typeof o.updatedAt === 'string' && !Number.isNaN(Date.parse(o.updatedAt)) ? o.updatedAt.slice(0, 40) : new Date().toISOString());

  // 6. Nothing valid left: the default panel for the profile.
  if (widgets.length === 0) {
    if (opts.fallback === false) return null;
    return defaultPanel(profile, opts.hint, version, updatedAt);
  }
  const summary = cleanText(o.summary, 140) || DEFAULT_SUMMARIES[profile];
  return { version, profile, summary, widgets, updatedAt };
}

/** A panel stored on NSGoal.panel (JSON string) -> the spec, or null when missing or corrupt. Ids are kept. */
export function parseStoredPanel(raw: unknown): PanelSpec | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return sanitizePanel(JSON.parse(raw), { fallback: false });
  } catch {
    return null;
  }
}

/** NSGoal.panelPrev (JSON array of specs, newest first) -> at most 10 valid specs. */
export function parseStoredPanelPrev(raw: unknown): PanelSpec[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .slice(0, 10)
      .map((spec) => sanitizePanel(spec, { fallback: false }))
      .filter((spec): spec is PanelSpec => spec !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// What the user did survives panel changes: checklist ticks and log ids
// ---------------------------------------------------------------------------

/**
 * `spec` with the checklist ticks of `from` (same item id, else same text); items `from`
 * does not have keep their own flag. Undo restores a layout, never old progress, and an
 * AI change saved after a tick keeps that tick.
 */
export function carryProgress(spec: PanelSpec, from: PanelSpec | null): PanelSpec {
  const items = checklistItems(from);
  if (items.length === 0) return spec;
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const byText = new Map<string, ChecklistItem>();
  for (const i of items) if (!byText.has(textKey(i.text))) byText.set(textKey(i.text), i);
  const widgets = spec.widgets.map((w): Widget => {
    if (w.type !== 'checklist') return w;
    return {
      ...w,
      items: w.items.map((item) => {
        const match = byId.get(item.id) ?? byText.get(textKey(item.text));
        return match ? { ...item, done: match.done } : item;
      }),
    };
  });
  return { ...spec, widgets };
}

/** The spec without checklist ticks, version and updatedAt: what a layout change changes. */
function layoutOf(spec: PanelSpec): string {
  const widgets = spec.widgets.map((w) =>
    w.type === 'checklist' ? { ...w, items: w.items.map(({ id, text }) => ({ id, text })) } : w
  );
  return JSON.stringify([spec.profile, spec.summary, widgets]);
}

/** True when the two specs differ at most in checklist ticks (both null counts as the same). */
export function sameLayout(a: PanelSpec | null, b: PanelSpec | null): boolean {
  if (!a || !b) return a === b;
  return layoutOf(a) === layoutOf(b);
}

/**
 * Entries hang on their log's id. When a redesign or an edit drops a log and adds one that
 * records the same things (a field with the same key and kind), the new log takes the old
 * id so the entries stay attached; widgets pointing at the new log follow it. The closest
 * match wins, and each old id goes to one log at most.
 */
export function keepLogIds(spec: PanelSpec, previous: PanelSpec | null): PanelSpec {
  const ids = new Set(spec.widgets.map((w) => w.id));
  const unclaimed = logWidgets(previous).filter((l) => !ids.has(l.id));
  if (unclaimed.length === 0) return spec;
  const oldIds = new Set(logWidgets(previous).map((l) => l.id));
  const renamed = new Map<string, string>();
  for (const log of logWidgets(spec)) {
    if (oldIds.has(log.id)) continue;
    let best: LogWidget | null = null;
    let bestShared = 0;
    for (const old of unclaimed) {
      const shared = log.fields.filter((f) => old.fields.some((o) => o.key === f.key && o.kind === f.kind)).length;
      if (shared > bestShared) {
        best = old;
        bestShared = shared;
      }
    }
    if (!best) continue;
    unclaimed.splice(unclaimed.indexOf(best), 1);
    renamed.set(log.id, best.id);
  }
  if (renamed.size === 0) return spec;
  const widgets = spec.widgets.map((w) => {
    const copy = structuredClone(w);
    copy.id = renamed.get(copy.id) ?? copy.id;
    if ('source' in copy) copy.source = renamed.get(copy.source) ?? copy.source;
    return copy;
  });
  return { ...spec, widgets };
}

// ---------------------------------------------------------------------------
// Default panels (the AI's fallback and the examples in its prompt)
// ---------------------------------------------------------------------------

/** The main number field of a default offline/quantity panel. */
export type FieldHint = { key: string; label: string; unit: string; target: number };

const GENERIC_HINT: FieldHint = { key: 'amount', label: 'Amount', unit: '', target: 100 };

/** The raw default widgets for a profile (with `ref`s, before sanitizing). */
export function defaultWidgets(profile: PanelProfile, hint: FieldHint = GENERIC_HINT): Array<Record<string, unknown>> {
  const time = { key: 'time', label: 'Time', kind: 'minutes', unit: 'min' };
  const amount = { key: hint.key, label: hint.label, kind: 'number', ...(hint.unit ? { unit: hint.unit } : {}) };
  switch (profile) {
    case 'screen':
    case 'project':
      return [
        { type: 'milestones', title: 'Milestones' },
        { type: 'focus_session', title: 'Focus session', minutes: [25, 50] },
      ];
    case 'offline':
      return [
        {
          type: 'log',
          ref: 'log',
          title: 'Log a session',
          fields: [time, amount, { key: 'feeling', label: 'Feeling', kind: 'rating' }],
          proof: 'optional',
          proofHint: 'A screenshot from your tracking app, or a photo of you doing it',
        },
        { type: 'streak', title: 'Sessions this week', source: 'log', cadence: 'weekly', perPeriod: 3 },
        { type: 'milestones', title: 'Milestones' },
      ];
    case 'habit':
      return [
        { type: 'log', ref: 'log', title: 'Check in', fields: [{ key: 'done', label: 'Done', kind: 'boolean' }], proof: 'none' },
        { type: 'habit_grid', title: 'Last 4 weeks', source: 'log', days: 28 },
        { type: 'streak', title: 'Daily streak', source: 'log', cadence: 'daily', perPeriod: 1 },
      ];
    case 'quantity':
      return [
        {
          type: 'log',
          ref: 'log',
          title: 'Add progress',
          fields: [{ ...amount, required: true }],
          proof: 'optional',
          proofHint: 'A screenshot or photo that shows it',
        },
        { type: 'counter', title: `Total ${hint.label.toLowerCase()}`, source: 'log', field: hint.key, unit: hint.unit, target: hint.target, period: 'total' },
        { type: 'chart', title: 'Per week', source: 'log', field: hint.key, unit: hint.unit, period: 'week', span: 8 },
      ];
    case 'mixed':
      return [
        { type: 'milestones', title: 'Milestones' },
        { type: 'focus_session', title: 'Focus session', minutes: [25] },
        { type: 'log', ref: 'log', title: 'Log time away from the screen', fields: [time], proof: 'optional', proofHint: 'A photo of you doing it' },
        { type: 'streak', title: 'Sessions this week', source: 'log', cadence: 'weekly', perPeriod: 3 },
      ];
  }
}

export function defaultPanel(
  profile: PanelProfile,
  hint: FieldHint = GENERIC_HINT,
  version = 1,
  updatedAt = new Date().toISOString()
): PanelSpec {
  const spec = sanitizePanel(
    { profile, summary: DEFAULT_SUMMARIES[profile], widgets: defaultWidgets(profile, hint) },
    { version, updatedAt, fallback: false }
  );
  if (!spec) throw new Error(`default panel for ${profile} is invalid`); // unreachable: the defaults are valid
  return spec;
}

// Keyword guesses for the designer's fallback, most specific first.
const GUESSES: Array<{ re: RegExp; profile: PanelProfile; hint?: FieldHint }> = [
  { re: /\bswim/i, profile: 'offline', hint: { key: 'distance', label: 'Distance', unit: 'm', target: 10000 } },
  {
    re: /\b(run|runs|running|jog|marathon|5k|10k|cycl|bike|biking|ride|walk|walking|hike|hiking|triathlon)/i,
    profile: 'offline',
    hint: { key: 'distance', label: 'Distance', unit: 'km', target: 100 },
  },
  { re: /\b(gym|lift|lifting|workout|strength|push-?ups?|pull-?ups?|squat)/i, profile: 'offline', hint: { key: 'sets', label: 'Sets', unit: 'sets', target: 100 } },
  { re: /\b(cook|cooking|bake|baking|recipe)/i, profile: 'offline', hint: { key: 'dishes', label: 'Dishes', unit: '', target: 30 } },
  { re: /\b(guitar|piano|violin|drums?|sing|singing|instrument)/i, profile: 'offline', hint: { key: 'pieces', label: 'Pieces played', unit: '', target: 50 } },
  { re: /\b(paint|painting|draw|drawing|sketch)/i, profile: 'offline', hint: { key: 'pieces', label: 'Pieces made', unit: '', target: 50 } },
  {
    re: /\b(yoga|climb|climbing|dance|dancing|tennis|football|soccer|basketball|boxing|martial)/i,
    profile: 'offline',
    hint: { key: 'effort', label: 'Effort', unit: '/10', target: 100 },
  },
  { re: /\b(every ?day|daily|habit|meditat|journal|floss|stretch|sleep|no sugar|quit|stop smoking|drink water)/i, profile: 'habit' },
  { re: /\bread\b.*\b(books?|pages?)\b|\bpages?\b/i, profile: 'quantity', hint: { key: 'pages', label: 'Pages', unit: 'pages', target: 1000 } },
  { re: /\b(save|saving|savings)\b/i, profile: 'quantity', hint: { key: 'saved', label: 'Saved', unit: '$', target: 1000 } },
  { re: /\b(app|startup|website|launch|ship|product|side project|business)\b/i, profile: 'project' },
  { re: /\b(thesis|write|writing|essay|novel|code|coding|program|study|studying|learn|course|exam|research|paper|dissertation)/i, profile: 'screen' },
];

/** A best-effort profile (and number field) from the goal's own words, for the designer's fallback. */
export function guessProfile(text: string): { profile: PanelProfile; hint: FieldHint } {
  for (const g of GUESSES) if (g.re.test(text)) return { profile: g.profile, hint: g.hint ?? GENERIC_HINT };
  return { profile: 'mixed', hint: GENERIC_HINT };
}

// ---------------------------------------------------------------------------
// Manual widget edits (no AI): remove, move, toggle a checklist item
// ---------------------------------------------------------------------------

export type WidgetOp = { kind: 'remove' } | { kind: 'move'; to: number } | { kind: 'toggle_item'; itemId: string };

export type WidgetOpResult = { ok: true; spec: PanelSpec } | { ok: false; status: number; error: string };

/** Apply one manual edit; the result is sanitized again (removing a log also removes its streaks, charts...). */
export function applyWidgetOp(spec: PanelSpec, widgetId: string, op: WidgetOp, now = new Date().toISOString()): WidgetOpResult {
  const index = spec.widgets.findIndex((w) => w.id === widgetId);
  if (index < 0) return { ok: false, status: 404, error: 'widget not found' };
  const widgets: Widget[] = spec.widgets.map((w) => structuredClone(w));
  if (op.kind === 'remove') {
    widgets.splice(index, 1);
  } else if (op.kind === 'move') {
    const to = Math.max(0, Math.min(widgets.length - 1, Math.round(op.to)));
    const [moved] = widgets.splice(index, 1);
    widgets.splice(to, 0, moved);
  } else {
    const widget = widgets[index];
    if (widget.type !== 'checklist') return { ok: false, status: 400, error: 'widget is not a checklist' };
    const item = widget.items.find((i) => i.id === op.itemId);
    if (!item) return { ok: false, status: 404, error: 'checklist item not found' };
    item.done = !item.done;
  }
  const next = sanitizePanel(
    { profile: spec.profile, summary: spec.summary, widgets },
    { previous: spec, version: spec.version + 1, updatedAt: now, fallback: false }
  );
  if (!next) return { ok: false, status: 409, error: 'a panel needs at least one widget' };
  return { ok: true, spec: next };
}

// ---------------------------------------------------------------------------
// Entries: values checked against the log widget's fields
// ---------------------------------------------------------------------------

export type EntryValues = Entry['values'];

export type ValuesResult = { ok: true; values: EntryValues } | { ok: false; error: string };

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
export const MAX_ENTRY_NUMBER = 100_000;

function strictNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && NUMBER_RE.test(raw.trim())) return Number(raw.trim());
  return null;
}

// Digits grouped in threes by one repeated separator ("1,500", "12,345,678", "1 500"): thousands.
const THOUSANDS_RE = /^\d{1,3}([, \u00A0\u202F])\d{3}(?:\1\d{3})*(?![\d,])/;

/**
 * Lenient: "5 km" -> 5, "31 min" -> 31 (the coach's values come from chat). "1,500 m" and
 * "1 500 m" are thousands; a lone comma is a decimal point ("5,2 km" -> 5.2).
 */
function looseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const grouped = THOUSANDS_RE.exec(s);
  if (grouped) s = grouped[0].split(grouped[1]).join('') + s.slice(grouped[0].length);
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Check `raw` against the log's fields: numbers and minutes finite and 0..100000,
 * ratings whole 1..5, booleans, text <= 120 chars, required fields present, at least one
 * value (an empty entry would still count as a session). Unknown keys are dropped. Strict
 * mode (the API) fails on the first bad value; lenient mode (the coach) drops bad optional
 * values and coerces "5 km" to 5.
 */
export function validateEntryValues(log: LogWidget, raw: unknown, lenient = false): ValuesResult {
  const o = asObject(raw);
  if (!o) return { ok: false, error: 'values must be an object' };
  const values: EntryValues = {};
  for (const field of log.fields) {
    const v = Object.prototype.hasOwnProperty.call(o, field.key) ? o[field.key] : undefined;
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    let value: number | string | boolean | null = null;
    let problem = '';
    if (!empty) {
      if (field.kind === 'number' || field.kind === 'minutes') {
        const n = lenient ? looseNumber(v) : strictNumber(v);
        if (n === null || n < 0 || n > MAX_ENTRY_NUMBER) problem = `${field.label} must be a number from 0 to ${MAX_ENTRY_NUMBER}`;
        else value = Math.round(n * 100) / 100;
      } else if (field.kind === 'rating') {
        const n = lenient ? looseNumber(v) : strictNumber(v);
        const r = n === null ? null : lenient ? Math.round(n) : n;
        if (r === null || !Number.isInteger(r) || r < 1 || r > 5) problem = `${field.label} must be a whole number from 1 to 5`;
        else value = r;
      } else if (field.kind === 'boolean') {
        if (typeof v === 'boolean') value = v;
        else if (lenient && typeof v === 'string' && /^(true|yes)$/i.test(v.trim())) value = true;
        else if (lenient && typeof v === 'string' && /^(false|no)$/i.test(v.trim())) value = false;
        else problem = `${field.label} must be true or false`;
      } else {
        const text = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : null;
        if (text === null || (!lenient && Array.from(text).length > 120)) problem = `${field.label} must be text of at most 120 characters`;
        else value = cleanText(text, 120) || null;
      }
    }
    if (problem && !lenient) return { ok: false, error: problem };
    if (value === null) {
      if (field.required) return { ok: false, error: `${field.label} is required` };
      continue;
    }
    values[field.key] = value;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: 'log at least one value' };
  return { ok: true, values };
}

/** The entry's first minutes-kind field value (0 if none), capped at 600. */
export function entryMinutes(log: LogWidget, values: EntryValues): number {
  for (const field of log.fields) {
    if (field.kind !== 'minutes') continue;
    const v = values[field.key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.min(600, v);
  }
  return 0;
}

/** Only the log widgets of a panel. */
export function logWidgets(spec: PanelSpec | null): LogWidget[] {
  return (spec?.widgets ?? []).filter((w): w is LogWidget => w.type === 'log');
}
