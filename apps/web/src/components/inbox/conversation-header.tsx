'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '@/components/ui';
import type { ConversationDto, MemberDto } from '@/lib/types';
import { AiModeSelect } from './ai-mode-select';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

const PRIORITY_TONE: Record<Priority, string> = {
  low: 'text-ink-subtle',
  normal: 'text-ink-muted',
  high: 'text-warning',
  urgent: 'text-danger',
};

const TAG_MAX_LENGTH = 40;
const TAG_LIMIT = 30;

function memberLabel(member: MemberDto): string {
  return member.displayName ?? member.name ?? member.email;
}

/**
 * The controls that let an agent actually work a conversation: who owns it, how urgent it is,
 * what it is about, and whether it is still open.
 *
 * Every control is optimistic in the sense that it disables while in flight and re-reads the
 * server's answer afterwards. Nothing here guesses: the conversation prop is the truth, and it
 * arrives back through the same realtime event that tells every other agent.
 */
export function ConversationHeader({
  conversation,
  members,
  online,
  busy,
  onAssign,
  onResumeAi,
  onPauseAi,
  onStatus,
  onPriority,
  onTags,
  onBack,
}: {
  conversation: ConversationDto;
  members: MemberDto[];
  online: boolean;
  busy: boolean;
  onAssign: (memberId: string | null) => void;
  /** "Let the AI continue": the assistant takes the conversation back. */
  onResumeAi: () => void;
  /** "Pause AI": the assistant stops here without anyone having to reply. */
  onPauseAi: () => void;
  onStatus: (status: 'open' | 'pending' | 'closed') => void;
  onPriority: (priority: Priority) => void;
  onTags: (tags: string[]) => void;
  onBack: () => void;
}) {
  const [tagDraft, setTagDraft] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
  const ai = conversation.ai;
  const tagInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tagOpen) tagInput.current?.focus();
  }, [tagOpen]);

  // A different conversation is a different set of tags; never carry a half-typed one across.
  useEffect(() => {
    setTagDraft('');
    setTagOpen(false);
  }, [conversation.id]);

  function addTag(event: FormEvent) {
    event.preventDefault();
    const tag = tagDraft.trim().slice(0, TAG_MAX_LENGTH);
    if (!tag) return;
    // Case-insensitive de-duplication: "Refund" and "refund" are one tag, not two.
    const exists = conversation.tags.some((entry) => entry.toLowerCase() === tag.toLowerCase());
    if (!exists && conversation.tags.length < TAG_LIMIT) {
      onTags([...conversation.tags, tag]);
    }
    setTagDraft('');
    setTagOpen(false);
  }

  const closed = conversation.status === 'closed';
  // Who it is assigned to used to be printed under the visitor's name. The select two elements to
  // the right already says it, so that line cost a row of header to repeat what was next to it.

  return (
    /**
     * Two rows that hold, instead of three that wrap into more.
     *
     * This header was identity, then controls, then tags, each on its own line with its own
     * margin - 149px of a 495px window, against 128px for the messages it sits above. The four
     * controls alone took two 32px rows at a 387px thread column, which is an ordinary width.
     *
     * Now: who it is on the first line with any tags, and the controls on a second that does not
     * wrap. `shrink-0` here keeps the header from being squeezed by the transcript; `min-h-0` on
     * the transcript is what makes the transcript the thing that gives.
     */
    <div className="shrink-0 space-y-1.5 border-b border-border px-4 py-2.5">
      {/* Who, and their tags. Short things that wrap harmlessly. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-ink-muted hover:text-ink lg:hidden"
        >
          ← Back
        </button>

        {/*
          Name and state on one line rather than two. Who it is assigned to is in the select
          immediately to the right and in the visitor panel, so repeating it here bought a second
          line of header for information already on screen twice.
        */}
        <div className="flex min-w-[8rem] flex-1 basis-40 items-baseline gap-2">
          <p className="truncate text-sm font-semibold text-ink">
            {conversation.visitor.name ?? conversation.visitor.email ?? 'Visitor'}
          </p>
          <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-subtle">
            {online ? 'Online now' : 'Offline'}
          </span>
          {ai && (ai.replyCount > 0 || ai.pausedAt) && (
            <span
              className={cn(
                'shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                ai.pausedAt ? 'bg-surface-raised text-ink-subtle' : 'bg-success-soft text-success',
              )}
              title={
                ai.pausedAt
                  ? 'The AI assistant is paused here: a person took over, or paused it.'
                  : 'The AI assistant is answering. Reply to take over.'
              }
            >
              {ai.pausedAt ? 'AI · paused' : 'AI answering'}
            </span>
          )}
          {ai && !closed && (ai.pausedAt || conversation.assignedMemberId) ? (
            <button
              type="button"
              disabled={busy}
              onClick={onResumeAi}
              title="Clear the assignment and let the assistant answer the next message"
              className="shrink-0 whitespace-nowrap text-[11px] font-medium text-brand hover:underline disabled:opacity-50"
            >
              Let the AI continue
            </button>
          ) : ai && !closed && ai.replyCount > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={onPauseAi}
              title="Stop the assistant answering this conversation"
              className="shrink-0 whitespace-nowrap text-[11px] font-medium text-ink-muted hover:underline disabled:opacity-50"
            >
              Pause AI
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {conversation.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[11px] text-ink-muted"
            >
              {tag}
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove tag ${tag}`}
                onClick={() => onTags(conversation.tags.filter((entry) => entry !== tag))}
                className="text-ink-subtle hover:text-danger disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}

          {tagOpen ? (
            <form onSubmit={addTag} className="inline-flex">
              <input
                ref={tagInput}
                value={tagDraft}
                maxLength={TAG_MAX_LENGTH}
                placeholder="Tag name"
                onChange={(event) => setTagDraft(event.target.value)}
                onBlur={() => {
                  if (!tagDraft.trim()) setTagOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setTagDraft('');
                    setTagOpen(false);
                  }
                }}
                className="h-6 w-28 rounded-full border border-border-strong bg-surface px-2 text-[11px] text-ink"
              />
            </form>
          ) : (
            conversation.tags.length < TAG_LIMIT && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setTagOpen(true)}
                className="rounded-full border border-dashed border-border-strong px-2 py-0.5 text-[11px] text-ink-subtle hover:text-ink disabled:opacity-50"
              >
                + Tag
              </button>
            )
          )}
        </div>
      </div>

      {/*
        The controls, on one line that does not wrap.
        
        Wrapping was the whole problem: at a 387px thread column these four controls took two
        32px rows, and with the name above and the tags below the header was 149px against 128px
        of messages. The assignee select gives up its width first (`min-w-0 flex-1`), everything
        else keeps its size, and if the column is narrower than the controls genuinely need, the
        row scrolls sideways rather than stealing another line from the transcript.
      */}
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
        <AiModeSelect propertyId={conversation.propertyId} />

        <label className="sr-only" htmlFor="conversation-assignee">
          Assign this conversation
        </label>
        <select
          id="conversation-assignee"
          value={conversation.assignedMemberId ?? ''}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
          className="h-8 w-full min-w-[6rem] max-w-[190px] flex-1 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] text-ink disabled:opacity-50"
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {memberLabel(member)}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="conversation-priority">
          Priority
        </label>
        <select
          id="conversation-priority"
          value={conversation.priority}
          disabled={busy}
          onChange={(event) => onPriority(event.target.value as Priority)}
          className={cn(
            'h-8 shrink-0 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] font-medium capitalize disabled:opacity-50',
            PRIORITY_TONE[conversation.priority as Priority],
          )}
        >
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>

        {closed ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus('open')}
            className="h-8 shrink-0 rounded-[var(--radius-control)] bg-brand px-3 text-[12px] font-medium text-ink-inverted disabled:opacity-50"
          >
            Reopen
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onStatus(conversation.status === 'pending' ? 'open' : 'pending')}
              className="h-8 shrink-0 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
            >
              {conversation.status === 'pending' ? 'Back to open' : 'Pending'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onStatus('closed')}
              className="h-8 shrink-0 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
