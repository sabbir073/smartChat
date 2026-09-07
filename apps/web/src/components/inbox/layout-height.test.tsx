import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', '..', path), 'utf8');

const layout = read('app/app/(dashboard)/layout.tsx');
const inbox = read('app/app/(dashboard)/inbox/page.tsx');
const thread = read('components/inbox/message-thread.tsx');
const header = read('components/inbox/conversation-header.tsx');

/**
 * The bug these pin: the transcript was 61 pixels tall in a 551-pixel window.
 *
 * Three things caused it and any one of them coming back reproduces it, which is why this is a
 * test rather than a comment. The shell let the page scroll and the inbox subtracted a hardcoded
 * `7.5rem` from the viewport to guess what was left; a flex child without `min-h-0` will not
 * shrink below its content, so the region that was supposed to give did not; and the fixed chrome
 * around the transcript — page title, filter row, conversation header, composer — added up to
 * more than four times the space left for the messages.
 *
 * These are string assertions on class names, which is a blunt instrument. It is the right one
 * here: none of this is reachable from a jsdom render (no layout engine, no heights), and the
 * failure mode is silent and visual.
 */
describe('inbox height', () => {
  it('the shell owns the viewport height rather than growing past it', () => {
    expect(layout).toContain('h-dvh');
    expect(layout).toContain('overflow-hidden');
    expect(layout).not.toContain('min-h-dvh lg:grid');
  });

  it('main is a flex column that can shrink, so a page can fill it', () => {
    expect(layout).toMatch(/id="main"[\s\S]{0,200}min-h-0/);
    expect(layout).toMatch(/id="main"[\s\S]{0,200}flex-1/);
  });

  /**
   * The magic number. It subtracted the top bar and the main padding by hand: wrong by 16px on
   * every screen, and wrong by a whole row whenever the top bar wrapped.
   */
  it('the inbox does not guess how much of the window is left', () => {
    expect(inbox).not.toContain('100dvh');
    expect(inbox).not.toMatch(/h-\[calc\(/);
    expect(inbox).toMatch(/flex min-h-0 flex-1 flex-col/);
  });

  it('the transcript is the region that grows, and can shrink to let it', () => {
    expect(thread).toMatch(/min-h-\[8rem\][\s\S]{0,40}flex-1[\s\S]{0,60}overflow-y-auto/);
  });

  /** If the composer and the header can be squeezed, the transcript stops being the region that gives. */
  it('the header and the composer hold their size instead of squeezing the transcript', () => {
    expect(header).toMatch(/shrink-0 border-b/);
    expect(thread).toMatch(/shrink-0 border-t/);
  });

  it('the conversation header is one wrapping row, not three stacked ones', () => {
    // The tag row used to be a sibling with its own top margin below the controls row.
    expect(header).not.toContain('mt-2 flex flex-wrap items-center gap-1.5');
    const rows = header.match(/className="flex flex-wrap items-center gap-x-3 gap-y-2"/g) ?? [];
    expect(rows).toHaveLength(1);
  });

  it('the filter bar shares a line with the title instead of taking its own', () => {
    expect(inbox).not.toMatch(/<div className="mb-3">\s*<FilterBar/);
    expect(inbox).toMatch(/mb-2 flex flex-wrap items-center/);
  });
});
