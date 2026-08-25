'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH } from '@smartchat/validation';
import { cn } from '@/components/ui';
import type { AgentMessage } from '@/lib/realtime';

interface ThreadMessage extends AgentMessage {
  delivery: 'pending' | 'sent' | 'failed';
}

function time(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageThread({
  messages,
  visitorTyping,
  visitorName,
}: {
  messages: ThreadMessage[];
  visitorTyping: boolean;
  visitorName: string;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  }, [messages.length]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, visitorTyping]);

  return (
    <div
      ref={container}
      className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {messages.map((message) => {
        const isNote = message.type === 'note';
        const fromAgent = message.senderType === 'agent';

        if (isNote) {
          return (
            <div key={message.clientMessageId ?? message.id} className="flex justify-center">
              <div className="max-w-[85%] rounded-[var(--radius-control)] border border-warning/30 bg-warning-soft px-3.5 py-2.5">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                  Internal note · only your team can see this
                </p>
                <p className="whitespace-pre-wrap break-words text-[13.5px] text-ink">
                  {message.body}
                </p>
              </div>
            </div>
          );
        }

        return (
          <div
            key={message.clientMessageId ?? message.id}
            className={cn('flex flex-col gap-1', fromAgent ? 'items-end' : 'items-start')}
          >
            <div
              className={cn(
                'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm',
                fromAgent
                  ? 'rounded-br-md bg-brand text-ink-inverted'
                  : 'rounded-bl-md bg-surface-raised text-ink',
                message.delivery === 'pending' && 'opacity-60',
                message.delivery === 'failed' && 'opacity-60 outline outline-1 outline-danger',
              )}
            >
              {message.body}
            </div>
            <div className="flex gap-2 px-1 text-[11px] text-ink-subtle">
              {fromAgent && message.senderName && <span>{message.senderName}</span>}
              <span>{time(message.createdAt)}</span>
              {message.delivery === 'pending' && <span>Sending…</span>}
              {message.delivery === 'failed' && (
                <span className="font-medium text-danger" role="alert">
                  Not sent
                </span>
              )}
            </div>
          </div>
        );
      })}

      {visitorTyping && (
        <div className="flex items-center gap-2 text-[13px] text-ink-subtle">
          <span className="flex gap-1">
            <span className="size-1.5 animate-bounce rounded-full bg-ink-subtle [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-ink-subtle [animation-delay:120ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-ink-subtle [animation-delay:240ms]" />
          </span>
          {visitorName} is typing
        </div>
      )}

      <div ref={bottom} />
    </div>
  );
}

/**
 * The agent's composer.
 *
 * The reply/note switch is the important control here: a note is written in the same box but is
 * never delivered to the visitor, so the mode must be visible at the moment of typing rather than
 * discovered afterwards.
 */
export function AgentComposer({
  disabled,
  disabledReason,
  onSend,
  onTyping,
}: {
  disabled: boolean;
  disabledReason?: string;
  onSend: (body: string, asNote: boolean) => void;
  onTyping: (typing: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const [asNote, setAsNote] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<number | null>(null);
  const typing = useRef(false);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(
    () => () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  function signalTyping() {
    // A note is not typed "at" the visitor, so it must not show them a typing indicator.
    if (asNote) return;
    if (!typing.current) {
      typing.current = true;
      onTyping(true);
    }
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      typing.current = false;
      onTyping(false);
    }, 2500);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = value.trim();
    if (!body || disabled) return;
    onSend(body, asNote);
    setValue('');
    if (typing.current) {
      typing.current = false;
      onTyping(false);
    }
    textarea.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        'border-t border-border p-3 transition-colors',
        asNote ? 'bg-warning-soft' : 'bg-surface',
      )}
    >
      <div className="mb-2 flex items-center gap-1">
        {(['reply', 'note'] as const).map((mode) => {
          const active = (mode === 'note') === asNote;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setAsNote(mode === 'note')}
              aria-pressed={active}
              className={cn(
                'rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
                active ? 'bg-ink text-ink-inverted' : 'text-ink-muted hover:bg-surface-raised',
              )}
            >
              {mode === 'reply' ? 'Reply' : 'Internal note'}
            </button>
          );
        })}
        {asNote && (
          <span className="ml-1 text-[12px] text-ink-muted">The visitor will not see this.</span>
        )}
      </div>

      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor="agent-composer">
          {asNote ? 'Write an internal note' : 'Write a reply'}
        </label>
        <textarea
          id="agent-composer"
          ref={textarea}
          rows={1}
          value={value}
          maxLength={MESSAGE_MAX_LENGTH}
          disabled={disabled}
          placeholder={
            disabled
              ? (disabledReason ?? 'You cannot reply right now')
              : asNote
                ? 'Write a note for your team…'
                : 'Write a reply…  (Enter to send, Shift+Enter for a new line)'
          }
          onChange={(event) => {
            setValue(event.target.value);
            signalTyping();
          }}
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:bg-surface-raised"
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          aria-label={asNote ? 'Save note' : 'Send reply'}
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-brand text-ink-inverted disabled:opacity-45"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <path
              d="M4 12 20 4l-3.2 8L20 20 4 12Z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}

export type { ThreadMessage };
