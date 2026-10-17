import 'dotenv/config';
import OpenAI from 'openai';
import { DETAIL_KINDS, type ChatMessage, type DetailKind, type Goal, type NewGoal, type Settings, type Stats } from './types.js';

const MODEL = process.env.CHAT_MODEL || 'zai-org/glm-5.3-flash';

const client = new OpenAI({
  baseURL: 'https://api.aiand.com/v1',
  apiKey: process.env.AIAND_API_KEY,
  timeout: 60_000,
  maxRetries: 0, // we do our own retry
});

export const FALLBACK_REPLY = 'Tell me a bit more about that?';

// Verbatim system prompt from the brief.
const DISCOVER_SYSTEM = `You are North Star, a warm, curious guide who helps a person find and name the goal they want to reach.
The interface shows a dark, empty universe. Once you truly understand their goal, a star is born for it.

How to talk:
- Ask ONE short question at a time (max 2 sentences). No lists, no bullet points, no emojis.
- Reflect back what you heard in a few words before asking, so they feel understood.
- Be specific and human, never generic. Use their words.
- Reply in the language the user writes in.

What you need to understand before the star can be born:
1. WHAT they want to reach, concretely.
2. WHY it matters to them personally.
3. What SUCCESS looks like (how they will know they made it).
4. WHEN: a deadline or time horizon (accept "no deadline" if they insist).
5. Where they are NOW and what has been in the way.

Track "understanding" from 0.0 to 1.0: how well you know all five. Raise it gradually, about 0.15-0.25 per good answer.
Only when understanding >= 0.85 AND you know at least WHAT, WHY and SUCCESS, set "ready": true and compile the goal.
Never set ready on the first user message. Usually 3-7 questions are needed.

When ready, your reply should be a short, warm sentence that names their goal back to them (the star appears as you say it).
Milestones: 3-6 concrete, ordered steps from where they are now to success. Each title max 6 words, starting with a verb.

Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.

Respond with ONLY a JSON object:
{"reply": string, "understanding": number, "ready": boolean, "suggestions": string[],
 "goal": null | {"title": string (max 6 words), "why": string (1 sentence), "successLooksLike": string (1 sentence),
                 "deadline": string | null (ISO date if known, else a short phrase or null), "milestones": string[]}}`;

// Verbatim system prompt from the brief, with {GOAL_JSON}, {TODAY} and {STATS_JSON} filled in at call time.
const COACH_SYSTEM_TEMPLATE = `You are North Star, a warm, honest coach. The user's goal is a star in their sky; each milestone is a smaller star that lights up when done.
Goal (JSON): {GOAL_JSON}
Today: {TODAY}. Their stats: {STATS_JSON}

If the goal's status is "brainstorm", it is a little star with few details. Help them add details lightly:
- Ask at most ONE short question per reply, about the first item in "missing" ("success": how they will know they made it; "steps": the first 2-3 concrete steps; "why": why it matters to them).
- Record what they tell you with actions. If they would rather just start, respect that and stop asking.
When the goal is "ready", keep track of their progress like a good accountant of effort:
- When the user says they finished a milestone, mark it done.
- When they describe work they did with a duration, log focus minutes (only time they say they actually spent).
- If they discover a missing step, add a milestone.
Always: reply in 1-3 short sentences, acknowledge concretely, no lists, no emojis, in the user's language. Never invent details or progress the user did not give you.
Whenever the user mentions why the goal matters, something in the way, something that pulls them off track, a sub-goal, a concrete action, or what working on it looks like on their screen, record it with an add_detail action (kind: motivation | obstacle | distraction | subgoal | action | on_track; text: at most 12 words, in their words). Do not repeat details already in the goal JSON.

Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.

Respond with ONLY a JSON object:
{"reply": string, "suggestions": string[],
 "actions": [ {"type":"set_details","why"?: string,"successLooksLike"?: string,"deadline"?: string,"title"?: string}
            | {"type":"add_milestone","title": string}
            | {"type":"complete_milestone","milestoneId": string}
            | {"type":"log_focus","minutes": number}
            | {"type":"add_detail","kind": string,"text": string} ]}`;

// Verbatim system prompt from the brief.
const CAPTURE_SYSTEM = `You are North Star. The person is writing down something they want to reach. Your job is to capture it as a goal right away, not to interview them.

If their message names a goal, aspiration or project (even vaguely), it is a goal:
- "title": the goal in at most 6 words, starting with a verb, using their words (e.g. "Run my first half marathon").
- "reply": one or two short, warm sentences. Name the goal back to them, tell them its little star is now in their sky under Brainstorm, and that they can add details whenever they like. You may end with ONE light, optional question about what success would look like. No lists, no emojis.
If the message is not a goal yet (a greeting, a question, small talk), set "isGoal": false and reply with one short sentence inviting them to write something they want to reach.
Detail kinds: "motivation" = why it matters to them, "obstacle" = something in the way, "distraction" = something that pulls them off track, plus "subgoal", "action", "on_track" = what working on it looks like on their screen.
If the message already says why it matters, what is in the way, or what distracts them, put those in "details" (same kinds as above, at most 12 words each). Otherwise "details": [].
Reply in the language the user writes in.

Also offer 2-3 suggested replies the user could tap instead of typing: short (max 8 words), written in the user's own voice, specific to what you just asked, ordered with the most likely or most helpful first. Never include an "other" option; the app adds it.

Respond with ONLY a JSON object:
{"isGoal": boolean, "title": string, "reply": string, "suggestions": string[], "details": [{"kind": string, "text": string}]}`;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

// Verbatim helpfulness style lines from ../SETTINGS.md; 'balanced' adds nothing.
const HELPFULNESS_LINES: Record<Settings['helpfulness'], string> = {
  quiet:
    'Style: be brief. One short sentence. Do not ask a question unless the user asks for help, and never push for details.',
  balanced: '',
  proactive:
    'Style: be an engaged coach. Each reply proposes one concrete next step, and in brainstorm asks one question that moves the goal toward ready.',
};

/** Append the user's helpfulness style line as the last line of a system prompt. */
function withHelpfulness(system: string, settings: Settings): string {
  const line = HELPFULNESS_LINES[settings.helpfulness];
  return line ? `${system}\n${line}` : system;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function fallbackUnderstanding(userTurns: number): number {
  // State-safe approximation: the server does not store understanding between turns,
  // so on failure we keep the client's perceived progress low.
  return clamp01(Math.min(0.15 * Math.max(userTurns, 1), 0.75));
}

/** 2-3 short, distinct tappable replies; anything malformed is dropped. */
export function parseSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim().replace(/^["']|["']$/g, '').slice(0, 80);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || /^(other|something else)/i.test(text)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === 3) break;
  }
  return out;
}

function capWords(s: string, maxWords: number, maxChars: number): string {
  return s.split(/\s+/).slice(0, maxWords).join(' ').slice(0, maxChars);
}

/** Parse the first JSON object out of an LLM reply (handles prose and ```json fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function messagePayload(system: string, messages: ChatMessage[]): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
}

/**
 * Call the LLM and parse a JSON object out of the reply.
 * Tries once with response_format json_object; on any LLM or parse failure retries
 * once (without JSON mode if the first call failed at the API level). Returns null
 * when both attempts fail — callers fall back to a safe reply instead of a 500.
 */
async function chatJson(system: string, messages: ChatMessage[]): Promise<Record<string, unknown> | null> {
  const payload = messagePayload(system, messages);
  let jsonMode = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const params: Record<string, unknown> = {
        model: MODEL,
        temperature: 0.6,
        messages: payload,
      };
      if (jsonMode) params.response_format = { type: 'json_object' };
      const res = await client.chat.completions.create(params as never);
      const choices = (res as { choices?: Array<{ message?: { content?: unknown } }> }).choices ?? [];
      const content = choices[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      const parsed = extractJson(text);
      if (parsed) return parsed;
    } catch {
      jsonMode = false; // retry, dropping JSON mode in case the API rejects it
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// discover(messages) -> { reply, understanding, ready, goal? }
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  reply: string;
  understanding: number; // clamped 0..1
  ready: boolean;
  goal: NewGoal | null;
  suggestions: string[];
}

function parseGoal(raw: unknown): NewGoal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  const title = capWords(String(g.title ?? '').trim(), 6, 80);
  if (!title) return null;
  const why = String(g.why ?? '').trim().slice(0, 200);
  const successLooksLike = String(g.successLooksLike ?? '').trim().slice(0, 200);
  if (!why || !successLooksLike) return null; // need at least WHAT, WHY and SUCCESS
  const deadlineRaw = g.deadline;
  const deadline = typeof deadlineRaw === 'string' && deadlineRaw.trim() ? deadlineRaw.trim().slice(0, 60) : null;
  const milestones = Array.isArray(g.milestones)
    ? g.milestones
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => capWords(s.trim(), 6, 80))
        .filter((s) => s.length > 0)
        .slice(0, 6)
    : [];
  if (milestones.length === 0) return null;
  return { title, why, successLooksLike, deadline, milestones };
}

export async function discover(messages: ChatMessage[]): Promise<DiscoveryResult> {
  const parsed = await chatJson(DISCOVER_SYSTEM, messages);
  const userTurns = messages.filter((m) => m.role === 'user').length;
  if (!parsed) {
    return {
      reply: FALLBACK_REPLY,
      understanding: fallbackUnderstanding(userTurns),
      ready: false,
      goal: null,
      suggestions: [],
    };
  }

  const rawReply = parsed.reply;
  const reply = typeof rawReply === 'string' && rawReply.trim() ? rawReply.trim() : FALLBACK_REPLY;

  const suggestions = parseSuggestions(parsed.suggestions);
  const rawUnderstanding = Number(parsed.understanding);
  const understanding = Number.isFinite(rawUnderstanding) ? clamp01(rawUnderstanding) : fallbackUnderstanding(userTurns);

  let ready = parsed.ready === true || parsed.ready === 'true';
  const goal = ready ? parseGoal(parsed.goal) : null;

  // Never ready on the first user message, whatever the model says.
  if (userTurns < 2) {
    ready = false;
    return { reply, understanding: Math.min(understanding, 0.45), ready, goal: null, suggestions };
  }
  if (ready && !goal) ready = false; // invalid goal -> keep discovering
  return { reply, understanding, ready, goal, suggestions };
}

// ---------------------------------------------------------------------------
// coach(goal, stats, messages) -> { reply, actions }
// ---------------------------------------------------------------------------

export interface CoachAction {
  type: 'set_details' | 'complete_milestone' | 'add_milestone' | 'log_focus' | 'add_detail';
  milestoneId?: string;
  title?: string;
  minutes?: number;
  why?: string;
  successLooksLike?: string;
  deadline?: string;
  kind?: DetailKind;
  text?: string;
}

export interface CoachResult {
  reply: string;
  actions: CoachAction[];
  suggestions: string[];
}

/** Valid detail candidate: known kind + non-empty text. */
function parseDetailCandidate(raw: unknown): { kind: DetailKind; text: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? '').trim();
  if (!(DETAIL_KINDS as readonly string[]).includes(kind)) return null;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) return null;
  return { kind: kind as DetailKind, text };
}

export async function coach(goal: Goal, stats: Stats, messages: ChatMessage[], settings: Settings): Promise<CoachResult> {
  const goalJson = JSON.stringify({
    id: goal.id,
    title: goal.title,
    why: goal.why,
    successLooksLike: goal.successLooksLike,
    deadline: goal.deadline,
    status: goal.status,
    missing: goal.missing,
    milestones: goal.milestones.map((m) => ({ id: m.id, title: m.title, done: m.done })),
    details: goal.details.map((d) => ({ kind: d.kind, text: d.text })),
  });
  const system = withHelpfulness(
    COACH_SYSTEM_TEMPLATE // function replacements avoid "$" patterns in JSON
      .replace('{GOAL_JSON}', () => goalJson)
      .replace('{TODAY}', () => new Date().toISOString().slice(0, 10))
      .replace('{STATS_JSON}', () => JSON.stringify(stats)),
    settings
  );

  const parsed = await chatJson(system, messages);
  if (!parsed) return { reply: FALLBACK_REPLY, actions: [], suggestions: [] };

  const rawReply = parsed.reply;
  const reply = typeof rawReply === 'string' && rawReply.trim() ? rawReply.trim() : FALLBACK_REPLY;

  const actions: CoachAction[] = [];
  let addMilestoneCount = 0;
  let addDetailCount = 0;
  if (Array.isArray(parsed.actions)) {
    for (const a of parsed.actions) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      const o = a as Record<string, unknown>;
      if (o.type === 'set_details') {
        const details: CoachAction = { type: 'set_details' };
        for (const key of ['title', 'why', 'successLooksLike', 'deadline'] as const) {
          const value = o[key];
          if (typeof value === 'string' && value.trim()) details[key] = value.trim();
        }
        if (details.title || details.why || details.successLooksLike || details.deadline) {
          actions.push(details);
        }
      } else if (o.type === 'complete_milestone' && typeof o.milestoneId === 'string') {
        actions.push({ type: 'complete_milestone', milestoneId: o.milestoneId.trim() });
      } else if (o.type === 'add_milestone' && typeof o.title === 'string' && o.title.trim()) {
        if (addMilestoneCount >= 4) continue; // max 4 add_milestone actions per turn
        addMilestoneCount++;
        actions.push({ type: 'add_milestone', title: capWords(o.title.trim(), 6, 80) });
      } else if (o.type === 'log_focus') {
        actions.push({ type: 'log_focus', minutes: Number(o.minutes) });
      } else if (o.type === 'add_detail') {
        if (addDetailCount >= 5) continue; // max 5 add_detail actions per turn
        const detail = parseDetailCandidate(o);
        if (!detail) continue; // valid kind and non-empty text only
        addDetailCount++;
        actions.push({ type: 'add_detail', kind: detail.kind, text: detail.text });
      }
    }
  }
  return { reply, actions, suggestions: parseSuggestions(parsed.suggestions) };
}

// ---------------------------------------------------------------------------
// capture(messages) -> { isGoal, title, reply, suggestions }
// ---------------------------------------------------------------------------

export interface CaptureResult {
  isGoal: boolean;
  title: string;
  reply: string;
  suggestions: string[];
  details: Array<{ kind: DetailKind; text: string }>;
}

export async function capture(messages: ChatMessage[], settings: Settings): Promise<CaptureResult> {
  const parsed = await chatJson(withHelpfulness(CAPTURE_SYSTEM, settings), messages);
  if (!parsed) {
    return { isGoal: false, title: '', reply: FALLBACK_REPLY, suggestions: [], details: [] };
  }
  const rawReply = parsed.reply;
  const reply = typeof rawReply === 'string' && rawReply.trim() ? rawReply.trim() : FALLBACK_REPLY;
  const isGoal = parsed.isGoal === true || parsed.isGoal === 'true';
  const title = capWords(String(parsed.title ?? '').trim(), 6, 80);
  const details: Array<{ kind: DetailKind; text: string }> = [];
  if (Array.isArray(parsed.details)) {
    for (const raw of parsed.details) {
      const detail = parseDetailCandidate(raw);
      if (detail) details.push(detail);
    }
  }
  return { isGoal, title, reply, suggestions: parseSuggestions(parsed.suggestions), details };
}

// ---------------------------------------------------------------------------
// checkFocus(goal, screen, camera) -> is the user working on their goal right now?
// ---------------------------------------------------------------------------

const VISION_MODEL = process.env.VISION_MODEL || 'zai-org/glm-5.3-flash';

const FOCUS_SYSTEM_TEMPLATE = `You check whether a person is working on their goal right now, from a screenshot of their screen and, if present, a webcam photo.
Goal: {GOAL_JSON}

Judge only what is visible.
- on_track: the main thing on screen plausibly serves the goal (relevant documents, code, tools, research, learning material, writing, anything in onTrackLooksLike), or the webcam shows them doing an offline activity tied to the goal (practising the instrument, reading, studying on paper, training).
- off_track: clearly unrelated entertainment, social feeds, shopping or games as the main activity, anything in knownDistractions, or nobody at the desk with nothing relevant happening.
- uncertain: anything you cannot judge fairly.
Be fair: a chat or music app in a corner is fine when the main window is work. Do not describe the person's appearance and do not quote private content from the screen.

{ROAST_PARAGRAPH}

Respond with ONLY a JSON object:
{"verdict": "on_track" | "off_track" | "uncertain", "confidence": number 0-1,
 "reason": string (max 14 words, second person, e.g. "You're editing your thesis draft in Word."),
 "nudge": string (one kind sentence to bring them back, only when off_track, else ""),
 "roast": string}`;

// Roast paragraph for the default 'mild'; replaced when roast is 'off', extended when 'spicy' (../SETTINGS.md).
const ROAST_MILD = `When off_track, also write "roast": one playful, witty line (max 18 words) teasing what they are doing instead of their goal, based on what is on the screen or what they are doing on camera. Tease the activity, never the person: nothing about looks, body, clothes, age, gender, ethnicity, their home, or private content on screen. Keep it PG, no swearing, and tie it back to their goal when you can, for example: "Cat video #47: the famous missing chapter of your thesis." Otherwise "roast" is "".`;

function roastParagraph(roast: Settings['roast']): string {
  if (roast === 'off') return 'Never write a roast; "roast" must be "".';
  if (roast === 'spicy') {
    return `${ROAST_MILD} Make it sharper and more sarcastic, like a friend who roasts you, but still PG and still never about the person.`;
  }
  return ROAST_MILD;
}

export interface FocusVerdict {
  verdict: 'on_track' | 'off_track' | 'uncertain';
  confidence: number;
  reason: string;
  nudge: string;
  roast: string;
}

const asDataUrl = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`);

export async function checkFocus(goal: Goal, screen: string, camera: string | null, settings: Settings): Promise<FocusVerdict> {
  const next = goal.milestones.find((m) => !m.done);
  const goalJson = JSON.stringify({
    title: goal.title,
    why: goal.why,
    successLooksLike: goal.successLooksLike,
    nextMilestone: next?.title ?? null,
    onTrackLooksLike: goal.details
      .filter((d) => d.kind === 'on_track' || d.kind === 'action')
      .map((d) => d.text),
    knownDistractions: goal.details.filter((d) => d.kind === 'distraction').map((d) => d.text),
  });
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: camera ? 'Image 1 is the screen. Image 2 is the webcam.' : 'This is the screen. There is no webcam image.' },
    { type: 'image_url', image_url: { url: asDataUrl(screen) } },
  ];
  if (camera) content.push({ type: 'image_url', image_url: { url: asDataUrl(camera) } });
  const system = FOCUS_SYSTEM_TEMPLATE // function replacements avoid "$" patterns in JSON
    .replace('{GOAL_JSON}', () => goalJson)
    .replace('{ROAST_PARAGRAPH}', () => roastParagraph(settings.roast));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: VISION_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      } as never);
      const text = (res as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      const parsed = extractJson(typeof text === 'string' ? text : '');
      if (!parsed) continue;
      const verdict = ['on_track', 'off_track', 'uncertain'].includes(String(parsed.verdict))
        ? (parsed.verdict as FocusVerdict['verdict'])
        : 'uncertain';
      const confidence = clamp01(Number(parsed.confidence) || 0);
      const reason = String(parsed.reason ?? '').trim().slice(0, 140) || 'Checked your screen.';
      const nudge = verdict === 'off_track' ? String(parsed.nudge ?? '').trim().slice(0, 200) : '';
      // Roast only when off_track and allowed, trimmed, max 200 chars; roast 'off' forces "".
      const roast =
        settings.roast !== 'off' && verdict === 'off_track' ? String(parsed.roast ?? '').trim().slice(0, 200) : '';
      return { verdict, confidence, reason, nudge, roast };
    } catch {
      // one retry
    }
  }
  return { verdict: 'uncertain', confidence: 0, reason: "Couldn't check this time.", nudge: '', roast: '' };
}
