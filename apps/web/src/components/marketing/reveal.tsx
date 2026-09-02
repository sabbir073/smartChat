'use client';

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';

/**
 * Reveal a block as it scrolls into view.
 *
 * One shared listener for the whole page rather than an IntersectionObserver per element, which is
 * the obvious implementation and the wrong one here. Two ways it failed:
 *
 * An observer only reports a *change* in intersection. Jump straight past an element - an anchor
 * link, the browser restoring a scroll position, Cmd+End - and it goes from "below the fold" to
 * "above the fold" without ever being sampled as intersecting, so no callback arrives and the
 * element stays at opacity 0 for the rest of the page's life. Scrolling back up shows a hole.
 *
 * And the "already on screen at mount" path used `requestAnimationFrame`, which does not run in a
 * background tab. A page opened in a new tab and read later rendered blank.
 *
 * A sweep answers "is its top above the fold line" directly, which is true in all three cases -
 * on screen, scrolled to, and jumped past - and needs no animation frame to be correct. It runs
 * on mount, on scroll and on resize, coalesced so a fast scroll costs one pass per frame at most,
 * and each element deregisters the moment it is shown.
 */

type Show = () => void;

const pending = new Set<{ node: HTMLElement; show: Show }>();
let listening = false;
let queued = false;

/** The line an element has to cross. A little above the fold, so it lands rather than pops. */
function fold(): number {
  return window.innerHeight * 0.88;
}

function sweep(): void {
  queued = false;
  for (const entry of [...pending]) {
    if (!entry.node.isConnected) {
      pending.delete(entry);
      continue;
    }
    if (entry.node.getBoundingClientRect().top < fold()) {
      pending.delete(entry);
      entry.show();
    }
  }
  if (pending.size === 0) stopListening();
}

/**
 * Coalesce to at most one sweep, whichever clock arrives first.
 *
 * A frame *and* a timer, raced, because `requestAnimationFrame` does not run in a background tab.
 * Relying on it alone meant a page opened in a background tab - Cmd-clicked from somewhere, read a
 * minute later - had scrolled but never swept, and sections below the first screen stayed at
 * opacity 0 until something else happened to schedule a frame. The `queued` flag means whichever
 * fires first does the work and the other finds nothing to do.
 */
function schedule(): void {
  if (queued) return;
  queued = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sweep);
  setTimeout(sweep, 120);
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // Coming back to a tab that scrolled while it was hidden.
  document.addEventListener('visibilitychange', schedule);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('scroll', schedule);
  window.removeEventListener('resize', schedule);
  document.removeEventListener('visibilitychange', schedule);
}

export function Reveal({
  children,
  as: Tag = 'div',
  delay = 0,
  className,
}: {
  children: ReactNode;
  as?: ElementType;
  /** Milliseconds, for staggering siblings. Kept small: a long stagger reads as a slow page. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || shown) return;

    /*
     * The hidden state is applied here, in an effect, and never in the server-rendered markup.
     * Until this runs the element carries no `data-reveal` and the CSS leaves it alone - so with
     * JavaScript disabled, before hydration, or if this file fails to load, the content is simply
     * visible. Hiding in CSS and showing in JS turns one broken script into a blank page.
     */
    node.dataset['reveal'] = 'pending';

    const entry = { node, show: () => setShown(true) };
    pending.add(entry);
    startListening();
    // Synchronous, so anything already on screen is shown on this tick rather than next frame.
    sweep();

    return () => {
      pending.delete(entry);
      if (pending.size === 0) stopListening();
    };
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={className}
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as Record<string, string>) : undefined}
      {...(shown ? { 'data-reveal': 'shown' } : {})}
    >
      {children}
    </Tag>
  );
}
