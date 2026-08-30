import { describe, expect, it } from 'vitest';
import { excerptFrom, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders the constructs a help article actually uses', () => {
    const html = renderMarkdown(
      ['# Refunds', '', 'We refund **within 14 days**.', '', '- Card', '- Bank transfer'].join(
        '\n',
      ),
    );
    expect(html).toContain('<h2>Refunds</h2>');
    expect(html).toContain('<strong>within 14 days</strong>');
    expect(html).toContain('<ul><li>Card</li><li>Bank transfer</li></ul>');
  });

  it('numbers an ordered list and does not merge it with a bulleted one', () => {
    const html = renderMarkdown(['1. First', '2. Second', '- Aside'].join('\n'));
    expect(html).toContain('<ol><li>First</li><li>Second</li></ol>');
    expect(html).toContain('<ul><li>Aside</li></ul>');
  });

  it('starts article headings at h2, under the article title', () => {
    expect(renderMarkdown('### Deep')).toContain('<h4>Deep</h4>');
  });

  // ---------------------------------------------------------------------------
  // The part that matters: an author is a person we trust to write, not to run code.
  // ---------------------------------------------------------------------------

  it('never lets an author emit a tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an attribute break-out attempt', () => {
    const html = renderMarkdown('An "image" `<img src=x onerror=alert(1)>` inline');
    // The words survive as text - that is the point - but no element is ever created to carry
    // them, so there is no attribute for `onerror` to be an attribute of.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;image&quot;');
  });

  it('refuses a javascript: link and leaves the source text visible', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('[click](javascript:alert(1))');
  });

  it('refuses the variants a block-list would miss', () => {
    for (const href of ['  JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'vbscript:x', '//evil.example']) {
      expect(renderMarkdown(`[x](${href})`)).not.toContain('<a href');
    }
  });

  it('accepts the addresses a reader can safely follow', () => {
    expect(renderMarkdown('[docs](https://example.com/a?b=1&c=2)')).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
    );
    expect(renderMarkdown('[more](/help/pricing)')).toContain('<a href="/help/pricing">more</a>');
    expect(renderMarkdown('[mail](mailto:help@example.com)')).toContain('href="mailto:help@example.com"');
  });

  it('keeps markup literal inside code', () => {
    const html = renderMarkdown(['```html', '<b>bold</b>', '```'].join('\n'));
    expect(html).toContain('<pre><code class="language-html">&lt;b&gt;bold&lt;/b&gt;</code></pre>');
  });

  it('does not let a stray placeholder shape become somebody else`s code span', () => {
    // The internal marker is a NUL, which is stripped from the source, so this is plain text.
    const html = renderMarkdown(`literal ${String.fromCharCode(0)}0${String.fromCharCode(0)} text`);
    expect(html).toBe('<p>literal 0 text</p>');
  });

  it('closes an unterminated code fence rather than swallowing the article', () => {
    const html = renderMarkdown(['```', 'const a = 1;'].join('\n'));
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
  });

  it('renders quotes, rules and inline emphasis', () => {
    const html = renderMarkdown(['> Careful.', '', '---', '', 'Some *emphasis* here.'].join('\n'));
    expect(html).toContain('<blockquote><p>Careful.</p></blockquote>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<em>emphasis</em>');
  });
});

describe('excerptFrom', () => {
  it('summarises the prose without the markup', () => {
    expect(excerptFrom('# Title\n\nWe refund **within 14 days** of purchase.')).toBe(
      'Title We refund within 14 days of purchase.',
    );
  });

  it('truncates on a boundary rather than mid-sentence forever', () => {
    const long = excerptFrom('word '.repeat(100), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });
});
