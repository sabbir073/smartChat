import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStickToBottom } from './stick-to-bottom';

/**
 * The bug this pins: a transcript that stopped following the conversation as soon as a message
 * was tall enough to move the reader more than a screen from the bottom.
 *
 * The old code measured the distance to the bottom *after* React had added the new message, so a
 * message taller than the threshold looked exactly like a reader who had scrolled up, and the
 * view stayed where it was while the answer arrived out of sight. Stickiness therefore has to
 * come from the reader's own scrolling, which is what these tests assert.
 *
 * jsdom has no layout: scrollHeight and friends are always zero and `scrollTo` does not exist. So
 * the element's geometry is stood up by hand, which is honest here - the arithmetic under test is
 * ours, not the browser's.
 */

function Transcript({ signal }: { signal: string }) {
  const { containerRef, hasNew, jumpToLatest } = useStickToBottom<HTMLDivElement>(signal);
  return (
    <div>
      <div data-testid="scroller" ref={containerRef}>
        {signal}
      </div>
      {hasNew && (
        <button type="button" onClick={jumpToLatest}>
          New messages
        </button>
      )}
    </div>
  );
}

let scrolled: Array<{ top: number; behavior?: ScrollBehavior }> = [];

/** Give the scroller a height, a viewport and a scroll position, the way a browser would. */
function measure(element: HTMLElement, geometry: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true });
  }
}

beforeEach(() => {
  scrolled = [];
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(options: { top: number; behavior?: ScrollBehavior }) {
      scrolled.push(options);
      Object.defineProperty(this, 'scrollTop', {
        value: options.top - (this as HTMLElement).clientHeight,
        configurable: true,
        writable: true,
      });
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useStickToBottom', () => {
  it('scrolls to the newest line when a message arrives and the reader is at the bottom', () => {
    const { rerender } = render(<Transcript signal="one" />);
    const scroller = screen.getByTestId('scroller');
    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    scrolled = [];
    // A tall new message: the distance to the bottom is now far more than the threshold, which is
    // exactly the case the old implementation read as "the reader has scrolled away".
    measure(scroller, { scrollHeight: 1600, clientHeight: 400, scrollTop: 600 });
    rerender(<Transcript signal="two" />);

    expect(scrolled.at(-1)?.top).toBe(1600);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();
  });

  it('leaves a reader who has scrolled up where they are, and offers them the way back', () => {
    const { rerender } = render(<Transcript signal="one" />);
    const scroller = screen.getByTestId('scroller');

    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });

    scrolled = [];
    measure(scroller, { scrollHeight: 1200, clientHeight: 400, scrollTop: 100 });
    rerender(<Transcript signal="two" />);

    expect(scrolled).toEqual([]);
    expect(screen.getByRole('button', { name: 'New messages' })).toBeTruthy();
  });

  it('follows again once the reader scrolls back down', () => {
    const { rerender } = render(<Transcript signal="one" />);
    const scroller = screen.getByTestId('scroller');

    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    act(() => scroller.dispatchEvent(new Event('scroll')));

    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 590 });
    act(() => scroller.dispatchEvent(new Event('scroll')));

    scrolled = [];
    measure(scroller, { scrollHeight: 1300, clientHeight: 400, scrollTop: 590 });
    rerender(<Transcript signal="two" />);

    expect(scrolled.at(-1)?.top).toBe(1300);
  });

  it('does not lose the reader mid-animation when a second message lands', () => {
    // The scroll events a smooth animation fires on its way down all report a large distance to
    // the bottom. Believed, they would un-pin the transcript while it is following.
    const { rerender } = render(<Transcript signal="one" />);
    const scroller = screen.getByTestId('scroller');

    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    act(() => scroller.dispatchEvent(new Event('scroll')));
    measure(scroller, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
    rerender(<Transcript signal="two" />);

    act(() => {
      screen.getByRole('button', { name: 'New messages' }).click();
    });

    // Half-way through the smooth scroll the browser reports a position that is not the bottom.
    measure(scroller, { scrollHeight: 1200, clientHeight: 400, scrollTop: 300 });
    act(() => scroller.dispatchEvent(new Event('scroll')));

    scrolled = [];
    measure(scroller, { scrollHeight: 1500, clientHeight: 400, scrollTop: 300 });
    rerender(<Transcript signal="three" />);

    expect(scrolled.at(-1)?.top).toBe(1500);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();
  });

  it('jumps to the latest and resumes following when the button is pressed', () => {
    const { rerender } = render(<Transcript signal="one" />);
    const scroller = screen.getByTestId('scroller');

    measure(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    act(() => scroller.dispatchEvent(new Event('scroll')));
    measure(scroller, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
    rerender(<Transcript signal="two" />);

    act(() => {
      screen.getByRole('button', { name: 'New messages' }).click();
    });
    expect(scrolled.at(-1)?.top).toBe(1200);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();

    scrolled = [];
    measure(scroller, { scrollHeight: 1500, clientHeight: 400, scrollTop: 800 });
    rerender(<Transcript signal="three" />);
    expect(scrolled.at(-1)?.top).toBe(1500);
  });
});
