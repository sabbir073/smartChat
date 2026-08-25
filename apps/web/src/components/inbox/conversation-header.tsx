'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '@/components/ui';
import type { ConversationDto, MemberDto } from '@/lib/types';

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
  onStatus: (status: 'open' | 'pending' | 'closed') => void;
  onPriority: (priority: Priority) => void;
  onTags: (tags: string[]) => void;
  onBack: () => void;
}) {
  const [tagDraft, setTagDraft] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
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
  const assignee = members.find((member) => member.id === conversation.assignedMemberId) ?? null;

  return (
    <div className="border-b border-border px-4 py-3">
      {/* Wraps rather than squeezing: the thread column is narrow, and a visitor's name being
          clipped to nothing is worse than the controls moving to a second line. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={onBack}
          className="mt-0.5 text-[13px] text-ink-muted hover:text-ink lg:hidden"
        >
          ← Back
        </button>

        <div className="min-w-[9rem] flex-1 basis-40">
          <p className="truncate text-sm font-semibold text-ink">
            {conversation.visitor.name ?? conversation.visitor.email ?? 'Visitor'}
          </p>
          <p className="truncate text-[12px] text-ink-subtle">
            {online ? 'Online now' : 'Offline'}
            {assignee ? ` · ${memberLabel(assignee)}` : ' · Unassigned'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor="conversation-assignee">
            Assign this conversation
          </label>
          <select
            id="conversation-assignee"
            value={conversation.assignedMemberId ?? ''}
            disabled={busy}
            onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
            className="h-8 max-w-[170px] rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] text-ink disabled:opacity-50"
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
              'h-8 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] font-medium capitalize disabled:opacity-50',
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
              className="h-8 rounded-[var(--radius-control)] bg-brand px-3 text-[12px] font-medium text-ink-inverted disabled:opacity-50"
            >
              Reopen
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus(conversation.status === 'pending' ? 'open' : 'pending')}
                className="h-8 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
              >
                {conversation.status === 'pending' ? 'Back to open' : 'Pending'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus('closed')}
                className="h-8 rounded-[var(--radius-control)] border border-border-strong px-3 text-[12px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
  );
}
