/**
 * Split a message body into text and the http(s) links inside it.
 *
 * Bodies are never rendered as markup - the text parts go into text nodes exactly as stored. Only
 * an address that starts with http:// or https:// becomes a link, and its href is the address as
 * written: no protocol guessing, no `javascript:`, no relative paths. Trailing punctuation stays
 * with the sentence, so "see https://example.com/help." links to /help, not to "/help.".
 */

export type BodyPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

const URL = /\bhttps?:\/\/[^\s<>()"']+/gi;
const TRAILER = /[.,;:!?)\]]+$/;

export function splitLinks(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(URL)) {
    const start = match.index ?? 0;
    let href = match[0];
    const trailer = TRAILER.exec(href)?.[0] ?? '';
    if (trailer) href = href.slice(0, -trailer.length);
    if (start > last) parts.push({ kind: 'text', text: body.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}
