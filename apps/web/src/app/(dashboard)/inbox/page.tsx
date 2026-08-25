'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import {
  AgentRealtimeClient,
  ulid,
  type AgentConnectionState,
  type AgentMessage,
} from '@/lib/realtime';
import { ConversationList } from '@/components/inbox/conversation-list';
import {
  MessageThread,
  AgentComposer,
  type ThreadMessage,
} from '@/components/inbox/message-thread';
import { VisitorPanel } from '@/components/inbox/visitor-panel';
import { Alert, EmptyState, Spinner, cn } from '@/components/ui';
import type { ConversationDto, PropertyDto } from '@/lib/types';

type StatusFilter = 'open' | 'closed' | 'all';

/**
 * The agent inbox.
 *
 * Two rules shape this screen. First, the socket is an accelerator, not a dependency: every
 * action here has an HTTP path that produces exactly the same result, so a dropped connection
 * degrades latency and nothing else. Second, a message is only ever keyed by its
 * `clientMessageId` until the server hands back a real id, which is what lets an optimistic
 * bubble and its confirmed twin collapse into one row instead of appearing twice.
 */
export default function InboxPage() {
  const { activeAccount } = useAuth();

  const [connection, setConnection] = useState<AgentConnectionState>('idle');
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, ThreadMessage[]>>({});
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [onlineVisitors, setOnlineVisitors] = useState<Set<string>>(new Set());
  const [visitorUrls, setVisitorUrls] = useState<Record<string, string>>({});
  const [typingIn, setTypingIn] = useState<Set<string>>(new Set());

  const clientRef = useRef<AgentRealtimeClient | null>(null);
  const selectedRef = useRef<string | null>(null);
  const typingTimers = useRef<Record<string, number>>({});
  /**
   * The socket handlers are installed once, but the list loader changes with the status filter.
   * Reading it through a ref means a late event always refetches with the filter that is on
   * screen now, not the one that was on screen when the socket connected.
   */
  const loadRef = useRef<(signal?: AbortSignal) => Promise<ConversationDto[]>>(async () => []);

  selectedRef.current = selectedId;

  // --- helpers ------------------------------------------------------------

  /**
   * Insert or replace a message in a thread.
   *
   * Matching is by `clientMessageId` first so the optimistic bubble is *updated* rather than
   * joined by a duplicate when the server echoes the same message back over the socket.
   */
  const upsertMessage = useCallback((message: ThreadMessage) => {
    setMessages((current) => {
      const thread = current[message.conversationId] ?? [];
      const index = thread.findIndex(
        (existing) =>
          (message.clientMessageId !== null &&
            existing.clientMessageId === message.clientMessageId) ||
          existing.id === message.id,
      );

      let next: ThreadMessage[];
      if (index >= 0) {
        next = thread.slice();
        next[index] = { ...(thread[index] as ThreadMessage), ...message };
      } else {
        next = thread.concat(message);
      }
      next.sort((a, b) => a.seq - b.seq);

      return { ...current, [message.conversationId]: next };
    });
  }, []);

  const loadConversations = useCallback(
    async (signal?: AbortSignal) => {
      setListError(null);
      try {
        const result = await api.get<ConversationDto[]>('/conversations', {
          query: {
            limit: 50,
            ...(statusFilter === 'all' ? {} : { status: statusFilter }),
          },
          ...(signal ? { signal } : {}),
        });
        setConversations(result.data);
        return result.data;
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return [];
        setListError(
          caught instanceof ApiError ? caught.message : 'The conversation list could not be loaded',
        );
        return [];
      } finally {
        setListLoading(false);
      }
    },
    [statusFilter],
  );

  // --- realtime -----------------------------------------------------------

  useEffect(() => {
    const client = new AgentRealtimeClient({
      onState: setConnection,

      onMessage: (message: AgentMessage) => {
        upsertMessage({ ...message, delivery: 'sent' });

        setConversations((current) => {
          const index = current.findIndex(
            (conversation) => conversation.id === message.conversationId,
          );
          // A message for a conversation this list has never seen means the list is stale.
          if (index < 0) {
            void loadRef.current();
            return current;
          }

          const conversation = current[index] as ConversationDto;
          const isOpen = selectedRef.current === message.conversationId;
          const updated: ConversationDto = {
            ...conversation,
            lastMessageAt: message.createdAt,
            messageSeq: Math.max(conversation.messageSeq, message.seq),
            agentUnreadCount:
              message.senderType === 'visitor' && !isOpen
                ? conversation.agentUnreadCount + 1
                : conversation.agentUnreadCount,
          };

          const next = current.slice();
          next.splice(index, 1);
          next.unshift(updated);
          return next;
        });

        // Whatever the visitor was typing, they have now sent it.
        if (message.senderType === 'visitor') {
          setTypingIn((current) => {
            if (!current.has(message.conversationId)) return current;
            const next = new Set(current);
            next.delete(message.conversationId);
            return next;
          });
          if (selectedRef.current === message.conversationId) {
            client.markRead(message.conversationId, message.seq);
          }
        }
      },

      onTyping: ({ conversationId, actorType, typing }) => {
        if (actorType !== 'visitor') return;
        setTypingIn((current) => {
          const next = new Set(current);
          if (typing) next.add(conversationId);
          else next.delete(conversationId);
          return next;
        });

        // A "typing" that is never followed by a "stop" (the visitor closed the tab mid-sentence)
        // would otherwise leave the indicator running forever.
        const existing = typingTimers.current[conversationId];
        if (existing) window.clearTimeout(existing);
        if (typing) {
          typingTimers.current[conversationId] = window.setTimeout(() => {
            setTypingIn((current) => {
              const next = new Set(current);
              next.delete(conversationId);
              return next;
            });
          }, 8_000);
        }
      },

      onVisitorPresence: ({ visitorId, online, url }) => {
        setOnlineVisitors((current) => {
          const next = new Set(current);
          if (online) next.add(visitorId);
          else next.delete(visitorId);
          return next;
        });
        if (typeof url === 'string' && url.length > 0) {
          setVisitorUrls((current) => ({ ...current, [visitorId]: url }));
        }
      },

      onPresenceSnapshot: (snapshot) => {
        const online = new Set<string>();
        const urls: Record<string, string> = {};
        for (const property of snapshot) {
          for (const visitor of property.visitors) {
            online.add(visitor.visitorId);
            if (visitor.url) urls[visitor.visitorId] = visitor.url;
          }
        }
        // A snapshot replaces rather than merges: it is the gateway's complete answer for the
        // properties just subscribed, so anyone missing from it is genuinely gone.
        setOnlineVisitors(online);
        setVisitorUrls((current) => ({ ...current, ...urls }));
      },

      onConversationEvent: () => {
        void loadRef.current();
      },
    });

    clientRef.current = client;
    void client.connect();

    return () => {
      for (const timer of Object.values(typingTimers.current)) window.clearTimeout(timer);
      typingTimers.current = {};
      client.close();
      clientRef.current = null;
    };
    // One client per account. Everything that changes more often than that - the status filter,
    // the open conversation - is reached through a ref, so the socket is never torn down and no
    // handler can act on a stale filter.
  }, [activeAccount?.id, upsertMessage]);

  // --- data ---------------------------------------------------------------

  useEffect(() => {
    loadRef.current = loadConversations;
    const controller = new AbortController();
    setListLoading(true);
    void loadConversations(controller.signal);
    return () => controller.abort();
  }, [loadConversations, activeAccount?.id]);

  // Subscribe to every property this agent can see, so a brand-new conversation arrives without
  // a poll. The gateway re-checks membership itself; this list is only a filter, never a grant.
  useEffect(() => {
    if (connection !== 'connected') return;
    let cancelled = false;

    void api
      .get<PropertyDto[]>('/properties')
      .then(async (result) => {
        if (cancelled) return;
        const ids = result.data.map((property) => property.id);
        if (ids.length === 0) return;
        await clientRef.current?.subscribe(ids);
      })
      .catch(() => {
        if (!cancelled) setListError('Live updates could not be started. Reload to try again.');
      });

    return () => {
      cancelled = true;
    };
  }, [connection, activeAccount?.id]);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const thread = selectedId ? (messages[selectedId] ?? []) : [];

  // --- actions ------------------------------------------------------------

  const openConversation = useCallback(async (conversation: ConversationDto) => {
    const previous = selectedRef.current;
    if (previous && previous !== conversation.id) {
      clientRef.current?.closeConversation(previous);
    }

    setSelectedId(conversation.id);
    selectedRef.current = conversation.id;
    setThreadError(null);
    setThreadLoading(true);

    // Clearing the badge locally is safe: the read receipt below is what actually persists it,
    // and a failed receipt only means the badge returns on the next load.
    setConversations((current) =>
      current.map((row) => (row.id === conversation.id ? { ...row, agentUnreadCount: 0 } : row)),
    );

    try {
      let history: AgentMessage[];
      if (clientRef.current?.connected) {
        history = await clientRef.current.openConversation(conversation.id);
      } else {
        const result = await api.get<AgentMessage[]>(`/conversations/${conversation.id}/messages`, {
          query: { limit: 50 },
        });
        history = result.data;
      }

      setMessages((current) => ({
        ...current,
        [conversation.id]: history
          .map((message) => ({ ...message, delivery: 'sent' as const }))
          .sort((a, b) => a.seq - b.seq),
      }));

      const lastSeq = history.at(-1)?.seq;
      if (lastSeq !== undefined) {
        if (clientRef.current?.connected) {
          clientRef.current.markRead(conversation.id, lastSeq);
        } else {
          await api
            .post(`/conversations/${conversation.id}/read`, { seq: lastSeq })
            .catch(() => undefined);
        }
      }
    } catch (caught) {
      setThreadError(
        caught instanceof ApiError ? caught.message : 'This conversation could not be opened',
      );
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const send = useCallback(
    (body: string, asNote: boolean) => {
      const conversationId = selectedRef.current;
      if (!conversationId) return;

      const clientMessageId = ulid();
      const optimistic: ThreadMessage = {
        id: `local-${clientMessageId}`,
        conversationId,
        // Sorted to the end until the server assigns the real sequence number.
        seq: Number.MAX_SAFE_INTEGER,
        clientMessageId,
        senderType: 'agent',
        senderId: null,
        senderName: null,
        type: asNote ? 'note' : 'text',
        body,
        createdAt: new Date().toISOString(),
        readAt: null,
        delivery: 'pending',
      };
      upsertMessage(optimistic);

      void (async () => {
        try {
          const client = clientRef.current;
          if (client?.connected) {
            const result = await client.send(conversationId, clientMessageId, body, asNote);
            upsertMessage({ ...result.message, delivery: 'sent' });
            return;
          }

          // Same operation, different transport. The `clientMessageId` makes this safe even if
          // the socket delivered the message after all and this is a second attempt.
          const result = await api.post<AgentMessage>(`/conversations/${conversationId}/messages`, {
            clientMessageId,
            body,
            type: asNote ? 'note' : 'text',
          });
          upsertMessage({ ...result.data, delivery: 'sent' });
        } catch {
          upsertMessage({ ...optimistic, delivery: 'failed' });
        }
      })();
    },
    [upsertMessage],
  );

  const onTyping = useCallback((typing: boolean) => {
    const conversationId = selectedRef.current;
    if (conversationId) clientRef.current?.typing(conversationId, typing);
  }, []);

  // --- render -------------------------------------------------------------

  const live = connection === 'connected';

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[520px] flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Inbox</h1>
          <span
            className="flex items-center gap-1.5 text-[12px] text-ink-muted"
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                'size-2 rounded-full',
                live ? 'bg-success' : connection === 'idle' ? 'bg-ink-subtle' : 'bg-warning',
              )}
            />
            {live ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Filter conversations">
          {(['open', 'closed', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              className={cn(
                'rounded-full px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                statusFilter === value
                  ? 'bg-ink text-ink-inverted'
                  : 'text-ink-muted hover:bg-surface-raised',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {!live && connection !== 'idle' && (
        <Alert tone="warning" className="mb-3">
          Not connected to the realtime service. Messages you send still go through, they just are
          not instant.
        </Alert>
      )}
      {listError && (
        <Alert tone="danger" className="mb-3">
          {listError}
        </Alert>
      )}

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-[var(--radius-surface)] border border-border bg-surface lg:grid-cols-[300px_minmax(0,1fr)_280px]">
        {/* Conversations */}
        <div
          className={cn(
            'min-h-0 overflow-y-auto border-border lg:border-r',
            selectedId ? 'hidden lg:block' : 'block',
          )}
        >
          {listLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="size-5 text-ink-subtle" />
              <span className="sr-only">Loading conversations</span>
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No conversations yet"
                description="When a visitor starts a chat on one of your sites, it appears here straight away."
              />
            </div>
          ) : (
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onlineVisitors={onlineVisitors}
              onSelect={(conversation) => void openConversation(conversation)}
            />
          )}
        </div>

        {/* Thread */}
        <div
          className={cn(
            'flex min-h-0 flex-col border-border lg:border-r',
            selectedId ? 'flex' : 'hidden lg:flex',
          )}
        >
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                title="Select a conversation"
                description="Pick someone from the list to read the history and reply."
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-border px-5 py-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="text-[13px] text-ink-muted hover:text-ink lg:hidden"
                >
                  ← Back
                </button>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {selected.visitor.name ?? selected.visitor.email ?? 'Visitor'}
                  </p>
                  <p className="truncate text-[12px] text-ink-subtle">
                    {onlineVisitors.has(selected.visitor.id) ? 'Online now' : 'Offline'}
                    {selected.status === 'closed' ? ' · Closed' : ''}
                  </p>
                </div>
              </div>

              {threadError && (
                <Alert tone="danger" className="m-3">
                  {threadError}
                </Alert>
              )}

              {threadLoading && thread.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <Spinner className="size-5 text-ink-subtle" />
                  <span className="sr-only">Loading messages</span>
                </div>
              ) : (
                <MessageThread
                  messages={thread}
                  visitorTyping={typingIn.has(selected.id)}
                  visitorName={selected.visitor.name ?? 'The visitor'}
                />
              )}

              <AgentComposer
                disabled={selected.status === 'closed'}
                disabledReason="This conversation is closed"
                onSend={send}
                onTyping={onTyping}
              />
            </>
          )}
        </div>

        {/* Visitor */}
        <div className="hidden min-h-0 overflow-y-auto lg:block">
          {selected ? (
            <VisitorPanel
              conversation={selected}
              online={onlineVisitors.has(selected.visitor.id)}
              currentUrl={visitorUrls[selected.visitor.id] ?? null}
            />
          ) : (
            <div className="p-6 text-[13px] text-ink-subtle">
              Visitor details appear here once a conversation is open.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
