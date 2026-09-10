import { z } from 'zod';

/**
 * What the model may say, and what happens to what it said.
 *
 * The reply is a decision plus text, never free text. The worker acts on the decision - posts an
 * answer, posts the ticket offer, hands off - and the model has no way to make it do anything
 * else; the schema below is the whole vocabulary. Then the text itself is checked: too long is
 * cut, markup is stripped, and a link is kept only if it points at one of the account's own
 * sites, so a passage that was tampered with cannot make the assistant send visitors elsewhere.
 *
 * An `answer` must cite at least one passage that was actually in the prompt. An answer with no
 * source is an answer the model made up, and it becomes the ticket offer - the operator's rule
 * that what the AI does not know, it does not guess. `chat` is the exception, on purpose: a
 * greeting, thanks, small talk or a general question that is not about the business is answered
 * in the model's own words, because "Hello" deserves "Hello", not a ticket form.
 */

export const REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['answer', 'chat', 'ticket', 'human'] },
    text: { type: 'string' },
    sources: { type: 'array', items: { type: 'integer' } },
    /** What the model noticed, for the worker to act on. It cannot act itself. */
    urgent: { type: 'boolean' },
    goodbye: { type: 'boolean' },
    /** One or two words naming what the visitor is asking about, for the conversation's tags. */
    topic: { type: 'string' },
  },
  required: ['decision', 'text', 'sources', 'urgent', 'goodbye', 'topic'],
};

const replySchema = z.object({
  decision: z.enum(['answer', 'chat', 'ticket', 'human']),
  text: z.string(),
  sources: z.array(z.number().int()).default([]),
  urgent: z.boolean().default(false),
  goodbye: z.boolean().default(false),
  topic: z.string().default(''),
});

export interface ModelReply {
  decision: 'answer' | 'chat' | 'ticket' | 'human';
  text: string;
  /** Passage numbers as the prompt numbered them (1-based), validated against what was shown. */
  sources: number[];
  /** The visitor said it is urgent, or that they are done. Signals for the worker, never actions. */
  urgent: boolean;
  goodbye: boolean;
  /** A short label for the subject, cleaned: lower case, letters and spaces, at most 30 characters. Empty when none. */
  topic: string;
}

export const MAX_REPLY_CHARS = 1_200;

export interface NormaliseOptions {
  /** How many passages the prompt contained; a source number outside 1..n is dropped. */
  passageCount: number;
  /** Hosts a link may point at. Anything else is removed from the text. */
  allowedHosts: string[];
  /**
   * What the answer is allowed to be made of: the passages the model saw, plus the visitor's
   * question and the owner's instructions. Every number in an answer must come from one of them
   * - a price, a date, a phone number or an hour that appears nowhere in this text was invented,
   * and the answer becomes the ticket offer. When omitted the check is skipped.
   */
  grounding?: string[];
  /**
   * Phrases that belong to the practice example in the prompt and to nothing else. A reply that
   * repeats one of them without a passage that also contains it has answered from the practice
   * shop, not from this business, and is refused.
   */
  practicePhrases?: string[];
}

export type ParseFailure = { ok: false; reason: string };
export type ParseSuccess = { ok: true; reply: ModelReply; downgraded?: string };

/** Parse and normalise raw model output. Never throws: a bad reply is a `ticket`, not a crash. */
export function parseReply(raw: string, options: NormaliseOptions): ParseSuccess | ParseFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { ok: false, reason: 'reply was not JSON' };
  }
  const result = replySchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: 'reply did not match the contract' };

  const sources = [...new Set(result.data.sources)].filter(
    (n) => n >= 1 && n <= options.passageCount,
  );
  let text = cleanText(result.data.text, options.allowedHosts);
  let decision = result.data.decision;
  let downgraded: string | undefined;

  if (decision === 'answer') {
    if (text.length === 0) {
      decision = 'ticket';
      downgraded = 'answer had no text';
    } else if (sources.length === 0) {
      decision = 'ticket';
      downgraded = 'answer cited no passage';
    } else if (options.grounding && !leakedPractice(text, options.practicePhrases ?? [], options.grounding)) {
      const invented = inventedNumbers(text, options.grounding);
      if (invented.length > 0) {
        decision = 'ticket';
        downgraded = `answer contained numbers not in the passages (${invented.slice(0, 3).join(', ')})`;
      }
    }
  }
  // A chat reply is the model's own words - a greeting, a general fact - and needs no passage,
  // but it does need words. It is the one decision where the model speaks without a citation, so
  // the prompt is strict about what it may be used for.
  if (decision === 'chat' && text.length === 0) {
    decision = 'ticket';
    downgraded = 'chat had no text';
  }
  // Measured on the production model: asked for opening hours that the passages did not have,
  // it answered with the practice shop's hours and cited passage 1. The practice example is the
  // only text in the prompt that is not about this business, so its facts are refused outright
  // unless a real passage happens to say the same thing.
  if ((decision === 'answer' || decision === 'chat') && options.practicePhrases) {
    const leaked = leakedPractice(text, options.practicePhrases, options.grounding ?? []);
    if (leaked) {
      decision = 'ticket';
      downgraded = `reply repeated the practice example ("${leaked}")`;
    }
  }
  if (decision !== 'answer' && decision !== 'chat') {
    // The offer and the handoff are said in the operator's own words; the model's are dropped.
    text = '';
  }
  return {
    ok: true,
    reply: {
      decision,
      text,
      sources: decision === 'answer' ? sources : [],
      urgent: result.data.urgent,
      goodbye: result.data.goodbye,
      topic: cleanTopic(result.data.topic),
    },
    ...(downgraded ? { downgraded } : {}),
  };
}

/** A tag, not a sentence: lower case, letters, digits and spaces, two words at most, 30 characters. */
export function cleanTopic(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLER_WORDS.has(word))
    .slice(0, 2);
  const topic = words.join(' ').slice(0, 30).trim();
  return GENERIC_TOPICS.has(topic) ? '' : topic;
}

/** Labels that say nothing. */
const GENERIC_TOPICS = new Set(['', 'general', 'other', 'question', 'help', 'support', 'chat', 'greeting', 'none', 'misc', 'unknown', 'inquiry', 'enquiry']);

/** Words a model sometimes copies from the question into the label ("what warranty", "the fees"). */
const FILLER_WORDS = new Set(['what', 'which', 'how', 'when', 'where', 'why', 'who', 'the', 'a', 'an', 'my', 'your', 'our', 'about', 'of', 'is', 'are', 'do', 'does', 'can', 'i', 'you', 'we']);

/**
 * Numbers in `text` that appear in none of the `sources`.
 *
 * Numbers are compared as runs of digits, so "5,000 BDT", "5000" and "৫,০০০" are the same
 * number and "10:00" matches "10:00 to 20:00". Other numeral systems the model may write in
 * (Bengali, Devanagari, Arabic-Indic) are folded to ASCII first. A run of digits is the unit: an
 * answer saying "200" is grounded by "200 BDT" but not by "2,000".
 */
export function inventedNumbers(text: string, sources: string[]): string[] {
  const allowed = new Set<string>();
  // Phone numbers get rewritten without their spaces and dashes ("+8801711000000" for
  // "+880 1711-000000"), so a long run is also looked for in each source with its separators
  // removed. Only long runs: with every digit of a passage run together, "15" would be found
  // inside "2015".
  const squashed: string[] = [];
  for (const source of sources) {
    const runs = digitRuns(source);
    for (const n of runs) allowed.add(n);
    squashed.push(runs.join(''));
  }
  const invented: string[] = [];
  // "1. Road bikes 2. Mountain bikes" - list markers are layout, not facts.
  const prose = text.replace(/(^|\n)\s*\d+[.)]\s/g, '$1');
  for (const n of digitRuns(prose)) {
    if (allowed.has(n) || invented.includes(n)) continue;
    if (n.length >= 7 && squashed.some((s) => s.includes(n))) continue;
    invented.push(n);
  }
  return invented;
}

const DIGIT_BLOCKS = [0x0030, 0x0660, 0x06f0, 0x0966, 0x09e6]; // ASCII, Arabic-Indic, Persian, Devanagari, Bengali

function digitRuns(text: string): string[] {
  const folded = Array.from(text, (ch) => {
    const code = ch.codePointAt(0)!;
    for (const zero of DIGIT_BLOCKS) {
      if (code >= zero && code <= zero + 9) return String(code - zero);
    }
    return ch;
  }).join('');
  // "5,000" and "5000" are the same number; a thousands separator (comma or thin space, followed
  // by exactly three digits) is dropped before the runs are taken. "10:00" stays two runs.
  return folded.replace(/(\d)[,\u2009\u00a0 ](?=\d{3}(?!\d))/g, '$1').match(/\d+/g) ?? [];
}

function leakedPractice(text: string, phrases: string[], grounding: string[]): string | null {
  for (const phrase of phrases) {
    // Whole words only: "KES" must not match inside "bikes".
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(text) && !grounding.some((g) => pattern.test(g))) return phrase;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Some models wrap JSON in a code fence or a sentence. Take the outermost object. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"']+/gi;

export function cleanText(text: string, allowedHosts: string[]): string {
  const allowed = allowedHosts.map((host) => host.toLowerCase());
  let out = text
    .replace(/<[^>]+>/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(URL_PATTERN, (url) => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const permitted = allowed.some((h) => host === h || host.endsWith(`.${h}`));
        return permitted ? url : '';
      } catch {
        return '';
      }
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > MAX_REPLY_CHARS) {
    const cut = out.slice(0, MAX_REPLY_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    out = (lastStop > MAX_REPLY_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  return out;
}

// --- suggestions for a person ----------------------------------------------------------------

/** Up to three candidate replies for the person handling a chat. */
export const SUGGESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['answer', 'clarify', 'acknowledge'] },
          text: { type: 'string' },
          sources: { type: 'array', items: { type: 'integer' } },
        },
        required: ['kind', 'text', 'sources'],
      },
    },
  },
  required: ['suggestions'],
};

const suggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum(['answer', 'clarify', 'acknowledge']),
        text: z.string(),
        sources: z.array(z.number().int()).default([]),
      }),
    )
    .default([]),
});

export interface ReplySuggestion {
  kind: 'answer' | 'clarify' | 'acknowledge';
  text: string;
  /** Passage numbers, validated. Only an `answer` carries any. */
  sources: number[];
}

/**
 * Suggestions are held to the same standard as an answer the assistant would post itself: an
 * "answer" must cite a passage and contain no invented number or practice fact - a person will
 * send it with one click, so a wrong one is worse here than in the widget, not better. Anything
 * that fails is dropped rather than downgraded; the other suggestions stand.
 */
export function parseSuggestions(raw: string, options: NormaliseOptions): ReplySuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return [];
  }
  const result = suggestionsSchema.safeParse(parsed);
  if (!result.success) return [];
  const out: ReplySuggestion[] = [];
  const seen = new Set<string>();
  for (const candidate of result.data.suggestions) {
    const text = cleanText(candidate.text, options.allowedHosts);
    if (!text || seen.has(text.toLowerCase())) continue;
    const sources = [...new Set(candidate.sources)].filter((n) => n >= 1 && n <= options.passageCount);
    if (options.practicePhrases && leakedPractice(text, options.practicePhrases, options.grounding ?? [])) continue;
    if (candidate.kind === 'answer') {
      if (sources.length === 0) continue;
      if (options.grounding && inventedNumbers(text, options.grounding).length > 0) continue;
    }
    seen.add(text.toLowerCase());
    out.push({ kind: candidate.kind, text, sources: candidate.kind === 'answer' ? sources : [] });
    if (out.length === 3) break;
  }
  return out;
}

