'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { CallDto } from '@smartchat/types';
import { callerLabel, clockText, incomingTitle, secondsOnCall } from '@/lib/call-store';
import { cn } from '@/components/ui';
import { useCalls, type ActiveCall } from './call-provider';
import { HangUpGlyph, MicrophoneGlyph, PhoneGlyph } from './call-glyphs';

/**
 * The bottom-right corner of every dashboard screen: a card per call ringing for me, a notice
 * where a card just was, and - when I am on a call whose conversation is not the one in front of
 * me - a pill with the controls that the thread bar would otherwise hold.
 *
 * Above the toasts on purpose. A toast is read; an Answer button is pressed, and a message that
 * covered it for four seconds would be a missed call.
 */
export function CallDock() {
  const calls = useCalls();
  const { incoming, notices, active, openConversationId } = calls;
  const activeCall = active ? (calls.calls.get(active.callId) ?? null) : null;
  const showPill = active !== null && active.conversationId !== openConversationId;

  if (incoming.length === 0 && notices.size === 0 && !showPill) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2"
      role="region"
      aria-label="Calls"
    >
      {[...notices].map(([callId, text]) => (
        <p
          key={callId}
          role="status"
          className="pointer-events-auto rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-sm text-ink-muted shadow-lg"
        >
          {text}
        </p>
      ))}
      {incoming.map((call) => (
        <IncomingCallCard key={call.id} call={call} />
      ))}
      {showPill && active && <ActiveCallPill active={active} call={activeCall} />}
    </div>
  );
}

function IncomingCallCard({ call }: { call: CallDto }) {
  const { answer, decline, propertyName, active } = useCalls();
  const [working, setWorking] = useState<'answer' | 'decline' | null>(null);

  return (
    <div
      role="group"
      aria-live="assertive"
      aria-label={`${incomingTitle(call)} from ${callerLabel(call)}`}
      className="pointer-events-auto rounded-[var(--radius-card)] border border-success/40 bg-surface p-4 shadow-xl ring-1 ring-success/20"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 animate-pulse items-center justify-center rounded-full bg-success-soft text-success">
          <PhoneGlyph size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-success">
            {incomingTitle(call)}
          </p>
          <p className="truncate text-sm font-semibold text-ink">{callerLabel(call)}</p>
          {call.visitor.name && call.visitor.email && (
            <p className="truncate text-[12.5px] text-ink-muted">{call.visitor.email}</p>
          )}
          <p className="truncate text-[12.5px] text-ink-subtle">{propertyName(call.propertyId)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={working !== null || active !== null}
          title={active ? 'Hang up your current call first' : undefined}
          onClick={() => {
            setWorking('answer');
            void answer(call.id).finally(() => setWorking(null));
          }}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-success text-[13px] font-semibold text-ink-inverted transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <PhoneGlyph />
          {working === 'answer' ? 'Answering…' : 'Answer'}
        </button>
        <button
          type="button"
          disabled={working !== null}
          onClick={() => {
            setWorking('decline');
            void decline(call.id).finally(() => setWorking(null));
          }}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border-strong text-[13px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
        >
          <HangUpGlyph />
          Decline
        </button>
      </div>
    </div>
  );
}

/** The controls for a call whose thread is not on screen: hear, mute, hang up, go to the chat. */
function ActiveCallPill({ active, call }: { active: ActiveCall; call: CallDto | null }) {
  const { hangUp, setMuted, unblockAudio, requestOpen } = useCalls();
  const router = useRouter();
  const pathname = usePathname();
  const seconds = useClock(call);

  function openChat() {
    if (!call) return;
    requestOpen(call.conversationId);
    if (pathname !== '/app/inbox')
      router.push(`/app/inbox?conversation=${encodeURIComponent(call.conversationId)}`);
  }

  return (
    <div className="pointer-events-auto rounded-[var(--radius-card)] border border-brand/40 bg-surface p-3 shadow-xl">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
          <PhoneGlyph size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            {active.phase === 'joining'
              ? 'Joining the call…'
              : call
                ? `On a call · ${callerLabel(call)}`
                : 'On a call'}
          </p>
          <p className="text-[12px] tabular-nums text-ink-subtle">
            {call?.answeredAt ? clockText(seconds) : 'Connecting'}
            {active.muted ? ' · muted' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void setMuted(!active.muted)}
          aria-pressed={active.muted}
          aria-label={active.muted ? 'Unmute' : 'Mute'}
          className={cn(
            'flex size-8 items-center justify-center rounded-full border transition-colors',
            active.muted
              ? 'border-warning bg-warning-soft text-warning'
              : 'border-border-strong text-ink-muted hover:bg-surface-raised',
          )}
        >
          <MicrophoneGlyph size={15} muted={active.muted} />
        </button>
        <button
          type="button"
          onClick={() => void hangUp()}
          aria-label="Hang up"
          className="flex size-8 items-center justify-center rounded-full bg-danger text-ink-inverted hover:bg-danger-hover"
        >
          <HangUpGlyph size={15} />
        </button>
      </div>
      {active.audioBlocked && (
        <button
          type="button"
          onClick={() => void unblockAudio()}
          className="mt-2 w-full rounded-[var(--radius-control)] bg-warning-soft px-3 py-1.5 text-[12.5px] font-medium text-warning"
        >
          Tap to hear the caller
        </button>
      )}
      {active.micError && (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          {active.micError}
        </p>
      )}
      {call && (
        <button
          type="button"
          onClick={openChat}
          className="mt-2 text-[12.5px] font-medium text-brand hover:underline"
        >
          Open the conversation
        </button>
      )}
    </div>
  );
}

/** Seconds on the call, ticking once a second while it is live; the recorded length once it ended. */
export function useClock(call: CallDto | null): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = call !== null && call.answeredAt !== null && call.status !== 'ended';
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  if (!call) return 0;
  return call.status === 'ended' ? call.durationSeconds : secondsOnCall(call, now);
}
