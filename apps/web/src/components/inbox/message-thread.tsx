'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH, expandShortcut } from '@smartchat/validation';
import { cn } from '@/components/ui';
import type { AgentMessage } from '@/lib/realtime';
import type { AiSuggestion, ShortcutDto } from '@/lib/types';
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
      /**
       * The one region that grows. `min-h-0` lets it shrink inside a flex column - without it a
       * flex child refuses to go below its content height and the scrolling lands somewhere else -
       * and the floor stops it collapsing to a couple of lines when the window is short.
       */
      className="min-h-[8rem] flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4"
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
        // Bots sit on the team's side of the transcript: they spoke for the business, and an
        // agent reading back must see at a glance which side each line came from.
        const fromBot = message.senderType === 'bot';
        const fromAgent = message.senderType === 'agent' || fromBot;
        const fromAi = fromBot && message.ai !== undefined;
        const aiSources = fromAi ? (message.ai?.sources ?? []) : [];

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
                fromBot
                  ? 'rounded-br-md border border-brand/30 bg-brand-soft text-ink'
                  : fromAgent
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
            <div className="flex flex-wrap gap-2 px-1 text-[11px] text-ink-subtle">
              {fromAgent && message.senderName && <span>{message.senderName}</span>}
              {fromBot && (
                <span
                  className="rounded border border-border px-1 text-[10px] font-semibold uppercase tracking-wide"
                  title={fromAi ? 'Written by the AI assistant' : 'Sent by an automation'}
                >
                  {fromAi ? 'AI' : 'Bot'}
                </span>
              )}
              {fromAi && message.ai?.offer === 'ticket' && <span>offered a ticket</span>}
              {fromAi && message.ai?.rating && (
                <span
                  className={cn('font-medium', message.ai.rating === 'up' ? 'text-success' : 'text-danger')}
                  title={message.ai.rating === 'up' ? 'The visitor found this helpful' : 'The visitor found this unhelpful'}
                >
                  {message.ai.rating === 'up' ? '👍 helpful' : '👎 not helpful'}
                </span>
              )}
              {aiSources.length > 0 && (
                <span>
                  from{' '}
                  {aiSources.map((source, i) => (
                    <span key={`${source.title}-${i}`}>
                      {i > 0 && ', '}
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                          {source.title}
                        </a>
                      ) : (
                        source.title
                      )}
                    </span>
                  ))}
                </span>
              )}
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
export interface SuggestedReply {
  draft: string | null;
  sources: Array<{ title: string; url: string | null }>;
  reason?: 'not_in_content' | 'wants_person' | 'unavailable' | 'no_question';
}

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
  onSuggest,
  suggestions = [],
}: {
  disabled: boolean;
  disabledReason?: string;
  /**
   * Ask the assistant for a draft of the reply. Absent when the plan has no AI agent. The draft
   * lands in the box for the agent to edit; nothing is sent by this.
   */
  onSuggest?: (() => Promise<SuggestedReply>) | undefined;
  /**
   * Replies the assistant drafted on its own when the visitor wrote, for the person to pick from.
   * A click puts one in the box; nothing is sent until the person sends it.
   */
  suggestions?: AiSuggestion[];
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
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ note: string; tone: 'ok' | 'none' } | null>(null);

  async function suggest() {
    if (!onSuggest || suggesting || disabled) return;
    setSuggesting(true);
    setSuggestion(null);
    try {
      const result = await onSuggest();
      if (result.draft) {
        setValue(result.draft);
        setAsNote(false);
        setToken(null);
        const from = result.sources.map((s) => s.title).join(', ');
        setSuggestion({ note: from ? `Drafted from ${from}. Read it, edit it, then send.` : 'Drafted by the assistant. Read it, edit it, then send.', tone: 'ok' });
        textarea.current?.focus();
      } else {
        setSuggestion({
          note:
            result.reason === 'wants_person'
              ? 'The visitor is asking for a person - that is you.'
              : result.reason === 'unavailable'
                ? 'The assistant is not reachable right now.'
                : result.reason === 'no_question'
                  ? 'There is no visitor message to answer yet.'
                  : 'Nothing in your website, files or key facts answers this. Once you reply, consider adding it to Key facts.',
          tone: 'none',
        });
      }
    } catch {
      setSuggestion({ note: 'Could not get a draft.', tone: 'none' });
    } finally {
      setSuggesting(false);
    }
  }

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
        // `shrink-0`: the composer keeps its size and the transcript above it absorbs the change.
        'shrink-0 border-t border-border p-2.5 transition-colors sm:p-3',
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
      {/* What the assistant would say, offered rather than sent. Hidden while the box has text
          in it so a half-written reply is never covered, and while writing a note. */}
      {suggestions.length > 0 && !asNote && !disabled && value.trim() === '' && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Suggested replies">
          <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-subtle">✦ Suggested</span>
          {suggestions.map((candidate, index) => (
            <button
              key={`${index}-${candidate.text.slice(0, 24)}`}
              type="button"
              onClick={() => {
                setValue(candidate.text);
                setToken(null);
                const from = candidate.sources.map((s) => s.title).join(', ');
                setSuggestion({
                  note: from ? `From ${from}. Read it, edit it, then send.` : 'Drafted by the assistant. Read it, edit it, then send.',
                  tone: 'ok',
                });
                textarea.current?.focus();
              }}
              title={candidate.text}
              className="max-w-full truncate rounded-full border border-border bg-surface-raised px-2.5 py-1 text-left text-[12.5px] text-ink transition-colors hover:border-brand hover:bg-brand-soft"
            >
              <span className="mr-1 text-ink-subtle">
                {candidate.kind === 'answer' ? 'Answer' : candidate.kind === 'clarify' ? 'Ask' : 'Reassure'}
              </span>
              {candidate.text}
            </button>
          ))}
        </div>
      )}
      {/* Its own line only when it has something extra to say. Two segmented buttons did not need
          34px of vertical space to themselves. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {(['reply', 'note'] as const).map((mode) => {
          const active = (mode === 'note') === asNote;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setAsNote(mode === 'note')}
              aria-pressed={active}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors',
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
        {onSuggest && !asNote && (
          <button
            type="button"
            disabled={disabled || suggesting}
            onClick={() => void suggest()}
            title="Ask the AI assistant to draft a reply from your content. You edit and send it."
            className="ml-auto rounded-full px-2.5 py-0.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {suggesting ? 'Drafting…' : '✦ Suggest a reply'}
          </button>
        )}
      </div>
      {suggestion && (
        <p className={cn('mb-1.5 text-[12px]', suggestion.tone === 'ok' ? 'text-ink-muted' : 'text-warning')} role="status">
          {suggestion.note}
        </p>
      )}

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
