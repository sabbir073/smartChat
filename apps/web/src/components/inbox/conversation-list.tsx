'use client';

import { Avatar, cn } from '@/components/ui';
import { countryFlag, countryName, pageLabel } from '@/lib/geo';
import type { ConversationViewer } from '@/lib/realtime';
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
  visitorPages = {},
  viewers = {},
  onSelect,
}: {
  conversations: ConversationDto[];
  selectedId: string | null;
  onlineVisitors: Set<string>;
  /** Live pages from presence. Falls back to the session's last recorded page when absent. */
  visitorPages?: Record<string, { url: string; title: string | null }>;
  /**
   * Who from the team has each conversation open right now, keyed by conversation id.
   *
   * Shown to everybody, including the person themselves: knowing your own name is on a chat is
   * how you know your colleagues can see you are on it. Nothing is shown for a conversation the
   * assistant is handling on its own, because nobody is reading it.
   */
  viewers?: Record<string, { at: number; list: ConversationViewer[] }>;
  onSelect: (conversation: ConversationDto) => void;
}) {
  return (
    <ul className="divide-y divide-border" role="list">
      {conversations.map((conversation) => {
        const selected = conversation.id === selectedId;
        const online = onlineVisitors.has(conversation.visitor.id);
        const label = conversation.visitor.name ?? conversation.visitor.email ?? 'Visitor';
        const country = conversation.session?.country ?? conversation.visitor.country;
        const flag = countryFlag(country);
        /**
         * Where they are. Live presence when they are online, the session's last page otherwise:
         * an agent picking up a conversation from an hour ago still wants to know which page it
         * came from.
         */
        const live = online ? visitorPages[conversation.visitor.id] : undefined;
        const page =
          live ??
          (conversation.session?.currentUrl
            ? { url: conversation.session.currentUrl, title: conversation.session.currentTitle }
            : null);
        const where = pageLabel(page);
        const watching = viewers[conversation.id]?.list ?? [];

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
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {flag && (
                      <span
                        className="shrink-0 text-[14px] leading-none"
                        role="img"
                        aria-label={countryName(country) ?? country ?? undefined}
                        title={countryName(country) ?? undefined}
                      >
                        {flag}
                      </span>
                    )}
                    <span className="truncate text-sm font-medium text-ink">{label}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-subtle">
                    {relativeTime(conversation.lastMessageAt)}
                  </span>
                </span>
                {where && (
                  <span
                    className={cn(
                      'mt-0.5 flex items-center gap-1 truncate text-[12px]',
                      online ? 'text-brand' : 'text-ink-subtle',
                    )}
                    title={page?.url}
                  >
                    <span aria-hidden="true">{online ? '●' : '○'}</span>
                    <span className="truncate">
                      {online ? 'On ' : 'Was on '}
                      {where}
                    </span>
                  </span>
                )}
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-[13px] text-ink-muted">
                    {conversation.subject ?? conversation.visitor.email ?? 'No subject'}
                  </span>
                  {(conversation.ai?.replyCount ?? 0) > 0 && !conversation.ai?.pausedAt && conversation.status !== 'closed' && (
                    <span
                      className="shrink-0 rounded-full bg-success-soft px-1.5 text-[10px] font-semibold uppercase tracking-wide text-success"
                      title="The AI assistant is answering this conversation"
                    >
                      AI
                    </span>
                  )}
                  {conversation.agentUnreadCount > 0 && (
                    <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-ink-inverted">
                      {conversation.agentUnreadCount > 9 ? '9+' : conversation.agentUnreadCount}
                    </span>
                  )}
                  {conversation.status === 'closed' && (
                    <span className="ml-auto shrink-0 text-[11px] text-ink-subtle">Closed</span>
                  )}
                </span>
                {watching.length > 0 && (
                  <span
                    className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-ink-muted"
                    title={`${watching.map((viewer) => viewer.name).join(', ')} ${watching.length === 1 ? 'has' : 'have'} this chat open`}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-subtle" aria-hidden="true">
                      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                      <circle cx="12" cy="12" r="2.6" />
                    </svg>
                    {watching.map((viewer) => (
                      <span key={viewer.memberId} className="inline-flex items-center gap-1">
                        <Avatar name={viewer.name} url={viewer.avatarUrl} size={16} />
                        <span className="max-w-[9rem] truncate">{viewer.name}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
