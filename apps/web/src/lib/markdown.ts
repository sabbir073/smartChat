/**
 * A deliberately small markdown renderer for help-centre articles.
 *
 * Article bodies are stored exactly as written, so the decision about what a browser is allowed to
 * do with them belongs here, at render time. The order matters more than the feature list: every
 * character of the author's text is HTML-escaped *first*, and only then are our own tags inserted
 * around the escaped text. Nothing an author types can therefore become markup - not a script
 * tag, not an `onerror=` attribute, not a stray closing tag - because by the time any tag exists,
 * their angle brackets are already entities.
 *
 * It supports what a help article actually needs: headings, paragraphs, lists, links, emphasis,
 * code, quotes and rules. It is not a CommonMark implementation and does not pretend to be; an
 * unsupported construct renders as the literal text the author wrote, which is a readable outcome
 * rather than a broken one.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

/**
 * Only addresses a reader can safely be sent to.
 *
 * An allow-list, not a `javascript:` block-list: a tab before the scheme, mixed case, and an
 * entity in the middle of the word all defeat a block-list, and none of them start with `https`.
 */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/\S+$/i.test(href)) return href;
  if (/^mailto:\S+@\S+$/i.test(href)) return href;
  // A relative link stays inside the help centre; a protocol-relative `//host` does not.
  if (href === '/' || /^\/[^/\s]\S*$/.test(href)) return href;
  return null;
}

/**
 * A marker that cannot appear in the text being marked.
 *
 * Code spans are lifted out before emphasis and links are applied, and put back afterwards. The
 * placeholder therefore has to be something the author could not have written themselves, or a
 * body containing the placeholder's own shape would be rewritten into somebody else's code span.
 * NUL is stripped from the source below, so it is available here.
 */
const MARK = String.fromCharCode(0);
const MARK_PATTERN = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

/** Inline rules, applied to text that has already been escaped. */
function inline(escaped: string): string {
  const codeSpans: string[] = [];

  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${MARK}${codeSpans.length - 1}${MARK}`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    // `&` in the author's URL is already `&amp;`, which is what an attribute needs anyway.
    const target = safeHref(href.replace(/&amp;/g, '&'));
    if (!target) return match;
    const attributes = target.startsWith('/')
      ? ''
      : ' target="_blank" rel="noopener noreferrer nofollow"';
    return `<a href="${escapeHtml(target)}"${attributes}>${label}</a>`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');

  return text.replace(MARK_PATTERN, (_match, index: string) => {
    return `<code>${codeSpans[Number(index)] as string}</code>`;
  });
}

interface ListState {
  ordered: boolean;
  items: string[];
}

/** Render markdown to HTML that is safe to insert into the page. */
export function renderMarkdown(source: string): string {
  const normalised = source.replace(/\r\n?/g, '\n').split(MARK).join('');
  const lines = escapeHtml(normalised).split('\n');
  const out: string[] = [];

  let list: ListState | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        const language = code.language ? ` class="language-${code.language}"` : '';
        out.push(`<pre><code${language}>${code.lines.join('\n')}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = /^\s*```([a-zA-Z0-9+-]{0,20})\s*$/.exec(line);
    if (fence) {
      flushAll();
      code = { language: fence[1] ?? '', lines: [] };
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      // An article body sits under the article's own `h1`, so its top level starts at `h2`.
      const level = Math.min(6, (heading[1] as string).length + 1);
      out.push(`<h${level}>${inline((heading[2] as string).trim())}</h${level}>`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr />');
      continue;
    }

    const quoted = /^&gt;\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push((quoted[1] as string).trim());
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet ?? numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] as string);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  // An unterminated fence still renders as code rather than swallowing the rest of the article.
  if (code) {
    out.push(`<pre><code>${code.lines.join('\n')}</code></pre>`);
  }
  flushAll();

  return out.join('\n');
}

/** First paragraph of an article, as plain text - used when an author wrote no summary. */
export function excerptFrom(source: string, limit = 200): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
