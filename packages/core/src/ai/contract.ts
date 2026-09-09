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
 * that what the AI does not know, it does not guess.
 */

export const REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['answer', 'ticket', 'human'] },
    text: { type: 'string' },
    sources: { type: 'array', items: { type: 'integer' } },
  },
  required: ['decision', 'text', 'sources'],
};

const replySchema = z.object({
  decision: z.enum(['answer', 'ticket', 'human']),
  text: z.string(),
  sources: z.array(z.number().int()).default([]),
});

export interface ModelReply {
  decision: 'answer' | 'ticket' | 'human';
  text: string;
  /** Passage numbers as the prompt numbered them (1-based), validated against what was shown. */
  sources: number[];
}

export const MAX_REPLY_CHARS = 1_200;

export interface NormaliseOptions {
  /** How many passages the prompt contained; a source number outside 1..n is dropped. */
  passageCount: number;
  /** Hosts a link may point at. Anything else is removed from the text. */
  allowedHosts: string[];
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
    }
  }
  if (decision !== 'answer') {
    // The offer and the handoff are said in the operator's own words; the model's are dropped.
    text = '';
  }
  return {
    ok: true,
    reply: { decision, text, sources: decision === 'answer' ? sources : [] },
    ...(downgraded ? { downgraded } : {}),
  };
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
