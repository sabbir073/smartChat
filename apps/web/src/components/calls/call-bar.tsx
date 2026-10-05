'use client';

import { useRef, useState } from 'react';
import type { CallDto } from '@smartchat/types';
import { barView, callerLabel, clockText } from '@/lib/call-store';
import { cn } from '@/components/ui';
import { useCalls } from './call-provider';
import { useClock } from './call-dock';
import { HangUpGlyph, MicrophoneGlyph, PhoneGlyph } from './call-glyphs';
import { TransferPicker } from './transfer-picker';

/**
 * The bar under the conversation header while the conversation is on a call.
 *
 * What it says comes from `barView`, which reads the DTO and nothing else. What it offers comes
 * from the room: while this tab is in the call's room it can mute and hang up whatever the DTO
 * says, and while it also holds the call it can transfer. Ringing for me: answer. The AI's, or a
 * colleague's: the state and the clock, and the transcript below says the rest - there is no
 * "take over" from the AI, because the server has no such move; the AI hands over by ringing
 * the team, and then this bar offers Answer.
 */
export function CallBar({ call }: { call: CallDto }) {
  const { me, active, answer, hangUp, transfer, setMuted, unblockAudio, decline } = useCalls();
  const view = barView(call, me);
  const seconds = useClock(call);
  const [picking, setPicking] = useState(false);
  const [answering, setAnswering] = useState(false);
  const transferButton = useRef<HTMLButtonElement>(null);
  const here = active !== null && active.callId === call.id;
  const canTransfer =
    here && view.mine && (call.status === 'active' || call.status === 'connecting');

  const tone =
    view.tone === 'ringing'
      ? 'border-success/40 bg-success-soft/60'
      : view.tone === 'ai'
        ? 'border-brand/30 bg-brand-soft/50'
        : view.tone === 'ended'
          ? 'border-border bg-surface-raised'
          : 'border-brand/30 bg-surface-raised';

  return (
    <div className={cn('shrink-0 border-b px-4 py-2', tone)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full',
            view.tone === 'ringing'
              ? 'animate-pulse bg-success text-ink-inverted'
              : view.tone === 'ended'
                ? 'bg-border text-ink-muted'
                : 'bg-brand text-ink-inverted',
          )}
        >
          <PhoneGlyph size={14} />
        </span>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="truncate text-[13px] font-semibold text-ink">
            {view.label}
            {view.clock && (
              <span className="ml-1.5 font-normal tabular-nums text-ink-muted">
                {clockText(seconds)}
              </span>
            )}
            {here && active.muted && (
              <span className="ml-1.5 font-normal text-warning">· muted</span>
            )}
          </p>
          <p className="truncate text-[12px] text-ink-subtle">
            {view.tone === 'ended' && call.durationSeconds > 0
              ? `${callerLabel(call)} · ${clockText(call.durationSeconds)}`
              : here && active.phase === 'joining'
                ? 'Connecting your microphone…'
                : callerLabel(call)}
          </p>
        </div>

        {view.answerable && !here && (
          <>
            <button
              type="button"
              disabled={answering || active !== null}
              title={active ? 'Hang up your current call first' : undefined}
              onClick={() => {
                setAnswering(true);
                void answer(call.id).finally(() => setAnswering(false));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-success px-3 text-[12.5px] font-semibold text-ink-inverted hover:opacity-90 disabled:opacity-50"
            >
              <PhoneGlyph />
              {answering ? 'Answering…' : 'Answer'}
            </button>
            <button
              type="button"
              disabled={answering}
              onClick={() => void decline(call.id)}
              className="h-8 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12.5px] font-medium text-ink-muted hover:bg-surface disabled:opacity-50"
            >
              Decline
            </button>
          </>
        )}

        {here && (
          <>
            {active.audioBlocked && (
              <button
                type="button"
                onClick={() => void unblockAudio()}
                className="h-8 rounded-[var(--radius-control)] bg-warning-soft px-3 text-[12.5px] font-medium text-warning"
              >
                Tap to hear the caller
              </button>
            )}
            <button
              type="button"
              onClick={() => void setMuted(!active.muted)}
              aria-pressed={active.muted}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-[12.5px] font-medium',
                active.muted
                  ? 'border-warning bg-warning-soft text-warning'
                  : 'border-border-strong text-ink-muted hover:bg-surface',
              )}
            >
              <MicrophoneGlyph muted={active.muted} />
              {active.muted ? 'Unmute' : 'Mute'}
            </button>
            {view.mine && (
              <div className="relative">
                <button
                  ref={transferButton}
                  type="button"
                  disabled={!canTransfer}
                  title={canTransfer ? undefined : 'Available once the call is connected'}
                  aria-haspopup="menu"
                  aria-expanded={picking}
                  onClick={() => setPicking((open) => !open)}
                  className="h-8 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12.5px] font-medium text-ink-muted hover:bg-surface disabled:opacity-50"
                >
                  Transfer
                </button>
                {picking && (
                  <TransferPicker
                    callId={call.id}
                    anchor={transferButton}
                    onPick={transfer}
                    onClose={() => setPicking(false)}
                  />
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => void hangUp()}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-danger px-3 text-[12.5px] font-semibold text-ink-inverted hover:bg-danger-hover"
            >
              <HangUpGlyph />
              {view.mine ? 'Hang up' : 'Leave'}
            </button>
          </>
        )}
      </div>
      {here && active.micError && (
        <p className="mt-1 text-[12px] text-danger" role="alert">
          {active.micError}
        </p>
      )}
    </div>
  );
}
