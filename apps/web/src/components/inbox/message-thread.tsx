'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH, expandShortcut } from '@smartchat/validation';
import { cn } from '@/components/ui';
import type { AgentMessage } from '@/lib/realtime';
import type { ShortcutDto } from '@/lib/types';
import { ShortcutPicker, readShortcutQuery } from './shortcut-picker';
import { AttachmentCard, formatBytes } from './attachment';

interface ThreadMessage extends AgentMessage {
  delivery: 'pending' | 'sent' | 'failed';
  /** While a file is on its way up, so the bubble shows progress rather than an empty box. */
  uploading?: { fileName: string; byteSize: number };
}

/**
 * The agent-facing wording for a system message.
 *
 * The dashboard says "the visitor" where the panel says "you", and names the colleague who acted
 * rather than calling them "the support team" - the same event, told from this side of it.
 */
function systemText(message: ThreadMessage): string {
  const event = message.event;
  if (!event) return message.body;

  const actor = event.by === 'visitor' ? 'The visitor' : (event.actorName ?? 'An agent');
  return event.kind === 'conversation.closed'
    ? `${actor} ended this chat`
    : `${actor} reopened this chat`;
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
        if (message.type === 'system') {
          return (
            <div key={message.id} className="flex items-center gap-3 py-1" role="status">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="whitespace-nowrap text-[11.5px] text-ink-subtle">
                {systemText(message)} · {time(message.createdAt)}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          );
        }

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
                'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl text-sm',
                message.attachment || message.uploading ? 'p-1.5' : 'px-3.5 py-2.5',
                fromAgent
                  ? 'rounded-br-md bg-brand text-ink-inverted'
                  : 'rounded-bl-md bg-surface-raised text-ink',
                message.delivery === 'pending' && 'opacity-60',
                message.delivery === 'failed' && 'opacity-60 outline outline-1 outline-danger',
              )}
            >
              {message.uploading ? (
                <span className="flex items-center gap-2.5 px-2 py-1.5">
                  <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13.5px]">{message.uploading.fileName}</span>
                    <span className="text-[11.5px] opacity-70">
                      Sending {formatBytes(message.uploading.byteSize)}
                    </span>
                  </span>
                </span>
              ) : message.attachment ? (
                <AttachmentCard attachment={message.attachment} fromAgent={fromAgent} />
              ) : (
                message.body
              )}
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
  shortcuts = [],
  onShortcutUsed,
  placeholderValues = {},
  onAttach,
  maxBytes = 26_214_400,
}: {
  disabled: boolean;
  disabledReason?: string;
  onSend: (body: string, asNote: boolean) => void;
  onTyping: (typing: boolean) => void;
  /** Saved replies this agent may insert. Empty is a valid state, not an error. */
  shortcuts?: ShortcutDto[];
  onShortcutUsed?: (shortcut: ShortcutDto) => void;
  /** Values for "{{visitor.name}}" and friends, from the conversation actually on screen. */
  placeholderValues?: Record<string, string | null>;
  /** Absent when this conversation cannot take a file - a closed one, for instance. */
  onAttach?: ((file: File) => void) | undefined;
  maxBytes?: number;
}) {
  const [value, setValue] = useState('');
  const [asNote, setAsNote] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<number | null>(null);
  const typing = useRef(false);

  /** The "/word" the caret is in, or null. Null is what closes the picker. */
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  /**
   * Refuse an obviously-too-large file before anything is uploaded.
   *
   * Not the enforcement - the server measures the real object - just the courtesy of saying so
   * now rather than after a minute of uploading.
   */
  function handleFile(file: File | undefined): void {
    if (!file || !onAttach) return;
    if (file.size === 0) {
      setFileError('That file is empty');
      return;
    }
    if (file.size > maxBytes) {
      setFileError(`That file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`);
      return;
    }
    setFileError(null);
    onAttach(file);
  }

  const matches = useMemo(() => {
    if (!token) return [];
    const query = token.query;
    return shortcuts
      .filter(
        (shortcut) =>
          shortcut.key.startsWith(query) || shortcut.title.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [shortcuts, token]);

  // Keep the highlight inside the list as it shrinks under the agent's typing.
  useEffect(() => {
    setActiveIndex((current) => (current < matches.length ? current : 0));
  }, [matches.length]);

  function syncToken(element: HTMLTextAreaElement): void {
    const found = readShortcutQuery(element.value, element.selectionStart ?? 0);
    setToken(found);
    if (found) setActiveIndex(0);
  }

  /**
   * Replace the "/word" with the shortcut's text.
   *
   * Expanded first, so the agent sees and can edit the final wording before it is sent - a
   * shortcut is a starting point, not an automated reply, and treating it as the latter is how
   * customers end up receiving a message addressed to the wrong person.
   */
  function insert(shortcut: ShortcutDto): void {
    const element = textarea.current;
    if (!element || !token) return;

    const caret = element.selectionStart ?? element.value.length;
    const body = expandShortcut(shortcut.body, placeholderValues);
    const next = `${value.slice(0, token.start)}${body}${value.slice(caret)}`;

    setValue(next.slice(0, MESSAGE_MAX_LENGTH));
    setToken(null);
    onShortcutUsed?.(shortcut);

    const cursor = token.start + body.length;
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(cursor, cursor);
    });
  }

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
    setToken(null);
    if (typing.current) {
      typing.current = false;
      onTyping(false);
    }
    textarea.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // While the picker is open it owns Enter, Tab and the arrow keys. Sending the message
    // instead of inserting the shortcut the agent is looking straight at would be surprising.
    if (token && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const picked = matches[activeIndex];
        if (picked) insert(picked);
        return;
      }
    }
    if (event.key === 'Escape' && token) {
      event.preventDefault();
      setToken(null);
      return;
    }
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
      onDragOver={(event) => {
        if (onAttach && !disabled) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttach || disabled) return;
        event.preventDefault();
        handleFile(event.dataTransfer.files[0]);
      }}
    >
      {fileError && (
        <p className="mb-2 text-[12.5px] text-danger" role="alert">
          {fileError}
        </p>
      )}
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

      {token && !disabled && (
        <ShortcutPicker
          shortcuts={matches}
          query={token.query}
          activeIndex={activeIndex}
          onPick={insert}
        />
      )}

      <div className="flex items-end gap-2">
        {onAttach && (
          <>
            <input
              ref={filePicker}
              type="file"
              className="sr-only"
              onChange={(event) => {
                handleFile(event.target.files?.[0]);
                // Cleared so choosing the same file twice in a row still fires a change.
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={disabled}
              aria-label="Attach a file"
              onClick={() => filePicker.current?.click()}
              className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink disabled:opacity-45"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <path
                  d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 1 1-3-3l7.5-7.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </>
        )}
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
            syncToken(event.target);
            signalTyping();
          }}
          // Moving the caret with the mouse or the arrow keys changes which word it is in, so
          // the picker has to follow it rather than only reacting to typing.
          onKeyUp={(event) => syncToken(event.currentTarget)}
          onClick={(event) => syncToken(event.currentTarget)}
          onBlur={() => setToken(null)}
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
