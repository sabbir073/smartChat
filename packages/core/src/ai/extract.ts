import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

// linkedom's DOM, typed loosely: this module walks nodes by tag and text and needs no more.
type DomNode = { nodeType: number; textContent: string | null; childNodes: Iterable<DomNode> };
type DomElement = DomNode & { tagName: string; getAttribute(name: string): string | null; remove(): void };

/**
 * A web page, reduced to what the assistant should read.
 *
 * Readability finds the article-like main content and drops navigation, footers, cookie banners
 * and the rest of the chrome. It gives up on short pages (a contact page is three lines), so the
 * fallback is the whole body with the chrome elements removed. Either way the result is
 * markdown-ish text - `#` headings, `-` list items, blank lines between blocks - which is what
 * the chunker expects and what lets a passage know which section it came from.
 */

export interface ExtractedPage {
  title: string;
  text: string;
  /** `<meta name="description">`, when present; used as the document's opening line. */
  description: string | null;
}

const DROP = 'script, style, noscript, template, iframe, svg, canvas, nav, footer, header, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], .cookie, .cookies, #cookie-banner';
const MIN_READABLE_CHARS = 400;

export function extractPage(html: string, url: string): ExtractedPage | null {
  const { document } = parseHTML(html);
  const title = clean(document.querySelector('title')?.textContent ?? '') || clean(document.querySelector('h1')?.textContent ?? '') || url;
  const description = clean(document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '') || null;

  let text = '';
  try {
    // Readability mutates the tree it is given; parse a second copy for it.
    const copy = parseHTML(html).document;
    const article = new Readability(copy as never, { charThreshold: MIN_READABLE_CHARS }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= MIN_READABLE_CHARS) {
      const { document: articleDoc } = parseHTML(`<body>${article.content}</body>`);
      text = toText(articleDoc.body as unknown as DomElement);
    }
  } catch {
    // Readability is best-effort; the fallback below always works.
  }
  if (!text) {
    for (const node of document.querySelectorAll(DROP)) node.remove();
    text = toText((document.body ?? document.documentElement) as unknown as DomElement);
  }
  text = text.trim();
  if (!text) return null;
  return { title, description, text };
}

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'DL', 'DD', 'DT', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DETAILS', 'SUMMARY']);

/** Walk the tree into markdown-ish text. */
function toText(root: DomElement | null): string {
  if (!root) return '';
  const parts: string[] = [];
  const walk = (node: DomNode): void => {
    if (node.nodeType === 3) {
      parts.push((node.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as DomElement;
    const tag = element.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      parts.push(`\n\n${'#'.repeat(Number(heading[1]))} ${clean(element.textContent ?? '')}\n\n`);
      return;
    }
    if (tag === 'LI') {
      parts.push('\n- ');
      for (const child of element.childNodes) walk(child);
      parts.push('\n');
      return;
    }
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    if (tag === 'TD' || tag === 'TH') {
      for (const child of element.childNodes) walk(child);
      parts.push(' | ');
      return;
    }
    const block = BLOCK.has(tag);
    if (block) parts.push('\n\n');
    for (const child of element.childNodes) walk(child);
    if (block) parts.push('\n\n');
  };
  walk(root);
  return parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ \| \n/g, '\n')
    .trim();
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
