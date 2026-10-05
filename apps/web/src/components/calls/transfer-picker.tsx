'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError } from '@/lib/api-client';
import { callsApi, type TransferTarget, type TransferTargets } from '@/lib/voice';
import { cn } from '@/components/ui';

/**
 * Where to send the call: one online colleague, or the AI assistant.
 *
 * A small popover rather than a modal, because the person is mid-call and the list is short. The
 * server is asked who is available the moment the picker opens - who is online changes by the
 * minute, and whether the AI may take a call depends on its capacity right now - so the list is
 * never a cached one. The AI entry appears only when the server says it may take the call.
 */
export function TransferPicker({
  callId,
  anchor,
  onPick,
  onClose,
}: {
  callId: string;
  /** The button that opened the picker: a press on it is the button's to handle, not a click outside. */
  anchor: RefObject<HTMLElement | null>;
  onPick: (target: TransferTarget) => Promise<void>;
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<TransferTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTargets(null);
    setError(null);
    callsApi
      .targets(callId, controller.signal)
      .then(setTargets)
      .catch((caught: unknown) => {
        if ((caught as Error).name === 'AbortError') return;
        setError(
          caught instanceof ApiError ? caught.message : 'Could not find out who is available.',
        );
      });
    return () => controller.abort();
  }, [callId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (container.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose, anchor]);

  async function pick(key: string, target: TransferTarget) {
    setBusy(key);
    try {
      await onPick(target);
      onClose();
    } finally {
      setBusy(null);
    }
  }

  const row =
    'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-raised disabled:opacity-50';
  const note = 'px-2.5 pb-2 text-[12px] text-ink-muted';

  return (
    <div
      ref={container}
      role="menu"
      aria-label="Transfer the call to"
      className="absolute right-0 top-full z-30 mt-1 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-1.5 shadow-lg"
    >
      <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        Transfer to
      </p>
      {error ? (
        <p className={cn(note, 'text-danger')} role="alert">
          {error}
        </p>
      ) : targets === null ? (
        <p className={note} role="status">
          Looking for colleagues…
        </p>
      ) : (
        <>
          {targets.members.length === 0 ? (
            <p className={note}>No colleague is available right now.</p>
          ) : (
            targets.members.map((member) => (
              <button
                key={member.id}
                type="button"
                role="menuitem"
                disabled={busy !== null}
                onClick={() => void pick(member.id, { to: 'member', memberId: member.id })}
                className={row}
              >
                <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="truncate">{member.name ?? 'A colleague'}</span>
                {busy === member.id && (
                  <span className="ml-auto text-[11px] text-ink-subtle">Ringing…</span>
                )}
              </button>
            ))
          )}
          {targets.ai ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void pick('ai', { to: 'ai' })}
              className={cn(row, 'border-t border-border')}
            >
              <span className="text-brand" aria-hidden="true">
                ✦
              </span>
              AI assistant
              {busy === 'ai' && (
                <span className="ml-auto text-[11px] text-ink-subtle">Joining…</span>
              )}
            </button>
          ) : (
            targets.members.length === 0 && (
              <p className={note}>The AI cannot take this call either.</p>
            )
          )}
        </>
      )}
    </div>
  );
}
