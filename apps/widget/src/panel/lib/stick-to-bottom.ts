/**
 * The widget's copy of the dashboard hook in apps/web/src/lib/stick-to-bottom.ts.
 *
 * Duplicated rather than shared for the same reason as the chime and the linkifier: the panel
 * is a standalone bundle that ships to other people's websites and depends on nothing of ours.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Keep a transcript pinned to its newest line.
 *
 * The rule people expect from every chat they have ever used: while you are at the bottom, new
 * messages push the view down and you never have to do anything; the moment you scroll up to read
 * something, you stay exactly where you put yourself, and a quiet button tells you there is
 * something new below.
 *
 * The subtlety is *when* "am I at the bottom?" is decided. Measuring it in an effect that runs
 * after new content has already been added answers a different question - the new message has
 * made the distance to the bottom large, so the transcript concludes the reader has scrolled away
 * and stops following, which is precisely the bug this replaces. So stickiness is recorded from
 * the reader's own scrolling, and consulted (not recomputed) when the content grows.
 *
 * A `ResizeObserver` covers the rest: a picture that finishes loading, a bubble that rewraps, a
 * typing indicator appearing - all change the height without changing the message list.
 */
export interface StickToBottom<T extends HTMLElement> {
  /** Put this on the scrolling element. */
  containerRef: RefObject<T | null>;
  /** True while the reader is away from the bottom and something new has arrived. */
  hasNew: boolean;
  /** Scroll to the newest line and resume following. */
  jumpToLatest: () => void;
}

/** How far from the bottom still counts as "at the bottom", in pixels. */
const NEAR_BOTTOM_PX = 80;

/** Longer than a smooth scroll across a transcript takes; see `animating` below. */
const SMOOTH_MS = 700;

export function useStickToBottom<T extends HTMLElement>(
  /** Anything whose change means new content: the message array, a typing flag. */
  signal: unknown,
): StickToBottom<T> {
  const containerRef = useRef<T | null>(null);
  const pinned = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  /**
   * Whether a smooth scroll of ours is in flight.
   *
   * A smooth scroll fires a scroll event for every frame of the journey, and at every one of them
   * the distance to the bottom is still large. Read as the reader's own scrolling, those events
   * would un-pin the transcript in the middle of the animation that is following the conversation
   * - so while ours is running, only *arriving* at the bottom is believed, and a timer settles
   * the question from the real position afterwards in case the reader interrupted it.
   *
   * Instant scrolls need none of this: they are over before the event, which therefore measures
   * the bottom and says exactly what it should.
   */
  const animating = useRef(false);
  const settle = useRef<number | null>(null);

  /** Where the reader is, in the only terms that matter. */
  const atBottom = useCallback((element: T): boolean => {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const element = containerRef.current;
      if (!element) return;
      if (behavior === 'smooth') {
        animating.current = true;
        if (settle.current !== null) window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => {
          animating.current = false;
          settle.current = null;
          // Whatever happened in between - the animation finished, or the reader grabbed the
          // scrollbar and stopped it - the position now is the answer.
          const current = containerRef.current;
          if (!current) return;
          pinned.current = atBottom(current);
          if (pinned.current) setHasNew(false);
        }, SMOOTH_MS);
      }
      element.scrollTo({ top: element.scrollHeight, behavior });
    },
    [atBottom],
  );

  // The reader's own scrolling is the only thing that changes whether we follow.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onScroll = () => {
      const bottom = atBottom(element);
      if (animating.current) {
        if (!bottom) return;
        animating.current = false;
        if (settle.current !== null) {
          window.clearTimeout(settle.current);
          settle.current = null;
        }
      }
      pinned.current = bottom;
      if (bottom) setHasNew(false);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [atBottom]);

  /**
   * Before the browser paints, so the new message never appears above the fold and then jumps.
   *
   * Instantly, not smoothly: a transcript that animates every arriving message spends its life
   * mid-scroll, and in a busy conversation each new message would restart a journey the last one
   * never finished. The smooth one is kept for `jumpToLatest`, where somebody asked for it.
   */
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    if (pinned.current) {
      scrollToBottom('auto');
      return;
    }
    setHasNew(true);
  }, [signal, scrollToBottom]);

  // Height changes that no render of ours caused: images, fonts, a bubble rewrapping.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom('auto');
    });
    for (const child of Array.from(element.children)) observer.observe(child);
    observer.observe(element);
    return () => observer.disconnect();
  }, [signal, scrollToBottom]);

  // A pending settle timer outlives the component otherwise, and fires into a dead ref.
  useEffect(() => {
    return () => {
      if (settle.current !== null) window.clearTimeout(settle.current);
    };
  }, []);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    setHasNew(false);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  return { containerRef, hasNew, jumpToLatest };
}
