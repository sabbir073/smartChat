'use client';

import { cn } from '@/components/ui';
import type { ConversationDto } from '@/lib/types';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(name: string | null, fallback: string): string {
  if (!name) return fallback.slice(0, 2).toUpperCase();
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function ConversationList({
  conversations,
  selectedId,
  onlineVisitors,
  onSelect,
}: {
  conversations: ConversationDto[];
  selectedId: string | null;
  onlineVisitors: Set<string>;
  onSelect: (conversation: ConversationDto) => void;
}) {
  return (
    <ul className="divide-y divide-border" role="list">
      {conversations.map((conversation) => {
        const selected = conversation.id === selectedId;
        const online = onlineVisitors.has(conversation.visitor.id);
        const label = conversation.visitor.name ?? conversation.visitor.email ?? 'Visitor';

        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                selected ? 'bg-brand-soft' : 'hover:bg-surface-raised',
              )}
            >
              <span className="relative shrink-0">
                <span className="flex size-9 items-center justify-center rounded-full bg-surface-raised text-[12px] font-semibold text-ink-muted">
                  {initials(conversation.visitor.name, conversation.visitor.id)}
                </span>
                {online && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-surface bg-success"
                    aria-label="Online"
                  />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{label}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-subtle">
                    {relativeTime(conversation.lastMessageAt)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-[13px] text-ink-muted">
                    {conversation.subject ?? conversation.visitor.email ?? 'No subject'}
                  </span>
                  {conversation.agentUnreadCount > 0 && (
                    <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-ink-inverted">
                      {conversation.agentUnreadCount > 9 ? '9+' : conversation.agentUnreadCount}
                    </span>
                  )}
                  {conversation.status === 'closed' && (
                    <span className="ml-auto shrink-0 text-[11px] text-ink-subtle">Closed</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
