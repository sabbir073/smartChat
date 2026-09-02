'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The widget, playing a conversation.
 *
 * Deliberately a *rendering* of the real widget rather than the widget itself. Embedding the live
 * one on the marketing site would open real conversations, on a real property, that a real person
 * would have to answer - and an unanswered demo chat is a worse advert than no chat at all. So
 * this is the same layout, colours and copy the product ships, driven by a script.
 *
 * Nothing here claims to be live: there is no fake "agent is online" badge and no invented name on
 * a real person. The agent is "Support", which is what an unnamed account actually shows.
 */

interface Line {
  from: 'visitor' | 'agent';
  text: string;
  /** Pause before this line appears, in ms. Roughly what typing it would take. */
  after: number;
}

const SCRIPT: Line[] = [
  { from: 'agent', text: 'Hello! Anything I can help with?', after: 900 },
  { from: 'visitor', text: 'My order says delivered but nothing arrived', after: 1900 },
  { from: 'agent', text: 'Sorry about that. Do you have the order number?', after: 2000 },
  { from: 'visitor', text: '#48120', after: 1400 },
  { from: 'agent', text: "Found it — it went to the depot. I've booked redelivery for Thursday.", after: 2400 },
];

const RESET_PAUSE = 5200;

export function WidgetPreview() {
  const [visible, setVisible] = useState(0);
  const [typing, setTyping] = useState<'visitor' | 'agent' | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Somebody who asked for less motion gets the finished conversation, not a blank panel.
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setVisible(SCRIPT.length);
      return;
    }

    let cancelled = false;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(resolve, ms);
        timers.current.push(id);
      });

    void (async () => {
      // Runs until the component unmounts; `cancelled` is checked after every await.
      for (;;) {
        for (const [index, line] of SCRIPT.entries()) {
          if (cancelled) return;
          setTyping(line.from);
          await wait(line.after);
          if (cancelled) return;
          setTyping(null);
          setVisible(index + 1);
          await wait(260);
        }
        await wait(RESET_PAUSE);
        if (cancelled) return;
        setVisible(0);
        await wait(700);
      }
    })();

    return () => {
      cancelled = true;
      for (const id of timers.current) clearTimeout(id);
      timers.current = [];
    };
  }, []);

  const lines = SCRIPT.slice(0, visible);

  return (
    <div
      className="mk-glow w-[320px] overflow-hidden rounded-[20px] border border-white/10 bg-surface text-left"
      // Decorative: the transcript is a scripted illustration, not content worth announcing.
      aria-hidden
    >
      {/* Header */}
      <div className="bg-gradient-to-br from-brand to-accent-violet px-4 py-3.5 text-ink-inverted">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 text-[13px] font-semibold">
            S
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight">Support</p>
            <p className="flex items-center gap-1.5 text-[11px] text-white/80">
              <span className="relative inline-flex size-1.5">
                <span className="mk-pulse-ring absolute inset-0 text-emerald-300" />
                <span className="relative size-1.5 rounded-full bg-emerald-300" />
              </span>
              Typically replies in a minute
            </p>
          </div>
        </div>
      </div>

      {/* Transcript */}
      <div className="flex h-[248px] flex-col justify-end gap-2 bg-canvas px-3 py-3">
        {lines.map((line, index) => (
          <div
            key={`${index}-${line.text}`}
            className={`mk-pop flex ${line.from === 'visitor' ? 'justify-end' : 'justify-start'}`}
          >
            <p
              className={`max-w-[82%] rounded-2xl px-3 py-2 text-[12.5px] leading-snug ${
                line.from === 'visitor'
                  ? 'rounded-br-md bg-brand text-ink-inverted'
                  : 'rounded-bl-md border border-border bg-surface text-ink'
              }`}
            >
              {line.text}
            </p>
          </div>
        ))}

        {typing && (
          <div className={`flex ${typing === 'visitor' ? 'justify-end' : 'justify-start'}`}>
            <span
              className={`mk-typing inline-flex items-center rounded-2xl px-3 py-2.5 ${
                typing === 'visitor'
                  ? 'rounded-br-md bg-brand text-ink-inverted'
                  : 'rounded-bl-md border border-border bg-surface text-ink-subtle'
              }`}
            >
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2.5">
        <span className="flex-1 text-[12.5px] text-ink-subtle">Write a message…</span>
        <span className="grid size-7 place-items-center rounded-full bg-brand text-ink-inverted">
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="m5 12 14 0M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      <p className="bg-surface pb-2 text-center text-[10px] text-ink-subtle">Powered by SmartChat</p>
    </div>
  );
}
