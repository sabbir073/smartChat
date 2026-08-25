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
import { ConversationHeader } from '@/components/inbox/conversation-header';
import { DEFAULT_FILTERS, FilterBar, type InboxFilters } from '@/components/inbox/filter-bar';
import {
  MessageThread,
  AgentComposer,
  type ThreadMessage,
} from '@/components/inbox/message-thread';
import { VisitorPanel } from '@/components/inbox/visitor-panel';
import { Alert, EmptyState, Spinner, cn, useToast } from '@/components/ui';
import type { ConversationDto, MemberDto, PropertyDto } from '@/lib/types';

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
  const toast = useToast();

  const [connection, setConnection] = useState<AgentConnectionState>('idle');
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_FILTERS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [updating, setUpdating] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The open conversation, held separately from the list.
   *
   * Closing a conversation removes it from the "Open" filter, and deriving the thread from the
   * list would make it disappear the instant the agent acted - no confirmation of what happened,
   * and no way to reopen it without hunting through the closed list. It stays on screen until the
   * agent picks something else.
   */
  const [selectedConversation, setSelectedConversation] = useState<ConversationDto | null>(null);
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

  /** The filters, as the API expects them. One place, so the first page and "load more" agree. */
  const queryFor = useCallback(
    (active: InboxFilters, after?: string) => ({
      limit: 30,
      ...(active.status === 'all' ? {} : { status: active.status }),
      ...(active.assigned === 'any' ? {} : { assigned: active.assigned }),
      ...(active.propertyId === 'all' ? {} : { propertyId: active.propertyId }),
      ...(active.search ? { search: active.search } : {}),
      ...(active.tags.length > 0 ? { tags: active.tags } : {}),
      ...(after ? { cursor: after } : {}),
    }),
    [],
  );

  const loadConversations = useCallback(
    async (signal?: AbortSignal) => {
      setListError(null);
      try {
        const result = await api.get<ConversationDto[]>('/conversations', {
          query: queryFor(filters),
          ...(signal ? { signal } : {}),
        });
        setConversations(result.data);
        setCursor((result.meta?.['cursor'] as string | null) ?? null);
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
    [filters, queryFor],
  );

  /**
   * Fetch the next page.
   *
   * Appends rather than replaces, and de-duplicates by id: a conversation that received a message
   * while the agent was reading has moved to the top of the list, so the server's page boundary
   * can legitimately hand back a row that is already on screen.
   */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.get<ConversationDto[]>('/conversations', {
        query: queryFor(filters, cursor),
      });
      setConversations((current) => {
        const seen = new Set(current.map((row) => row.id));
        return current.concat(result.data.filter((row) => !seen.has(row.id)));
      });
      setCursor((result.meta?.['cursor'] as string | null) ?? null);
    } catch (caught) {
      setListError(
        caught instanceof ApiError ? caught.message : 'More conversations could not be loaded',
      );
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, filters, queryFor]);

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

  // The reference data the filters and the assign control are built from.
  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([
      api.get<PropertyDto[]>('/properties', { signal: controller.signal }),
      api.get<{ members: MemberDto[] }>('/account/members', { signal: controller.signal }),
    ])
      .then(([propertyResult, memberResult]) => {
        setProperties(propertyResult.data);
        // Only people who could actually pick the conversation up belong in the assign list.
        setMembers(memberResult.data.members.filter((member) => member.status === 'active'));
      })
      .catch((caught: unknown) => {
        if ((caught as Error).name === 'AbortError') return;
        setListError('Websites and team members could not be loaded.');
      });

    return () => controller.abort();
  }, [activeAccount?.id]);

  // Subscribe to every property this agent can see, so a brand-new conversation arrives without
  // a poll. The gateway re-checks membership itself; this list is only a filter, never a grant.
  useEffect(() => {
    if (connection !== 'connected' || properties.length === 0) return;
    let cancelled = false;

    void clientRef.current?.subscribe(properties.map((property) => property.id)).catch(() => {
      if (!cancelled) setListError('Live updates could not be started. Reload to try again.');
    });

    return () => {
      cancelled = true;
    };
  }, [connection, properties]);

  /**
   * Every tag in use, for the filter bar.
   *
   * Derived from the loaded page rather than fetched: a dedicated endpoint would be a second
   * round trip to tell the agent about tags on conversations they are not looking at.
   */
  const knownTags = useMemo(() => {
    const tags = new Set<string>();
    for (const conversation of conversations) for (const tag of conversation.tags) tags.add(tag);
    for (const tag of filters.tags) tags.add(tag);
    return [...tags].sort((a, b) => a.localeCompare(b));
  }, [conversations, filters.tags]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return (
      conversations.find((conversation) => conversation.id === selectedId) ?? selectedConversation
    );
  }, [conversations, selectedId, selectedConversation]);

  const thread = selectedId ? (messages[selectedId] ?? []) : [];

  // --- actions ------------------------------------------------------------

  const openConversation = useCallback(async (conversation: ConversationDto) => {
    const previous = selectedRef.current;
    if (previous && previous !== conversation.id) {
      clientRef.current?.closeConversation(previous);
    }

    setSelectedId(conversation.id);
    setSelectedConversation(conversation);
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

  /**
   * Apply a change to the open conversation and fold the server's answer back into the list.
   *
   * Deliberately not optimistic. These are decisions other agents act on - who owns a
   * conversation, whether it is still open - and showing a change that the server then refused
   * would be worse than a moment of latency. The row is only rewritten once the API confirms it.
   */
  const mutate = useCallback(
    async (
      apply: (conversationId: string) => Promise<Partial<ConversationDto>>,
      describe: string,
    ) => {
      const conversationId = selectedRef.current;
      if (!conversationId || updating) return;

      setUpdating(true);
      try {
        const patch = await apply(conversationId);
        setConversations((current) =>
          current.map((row) => (row.id === conversationId ? { ...row, ...patch } : row)),
        );
        setSelectedConversation((current) =>
          current && current.id === conversationId ? { ...current, ...patch } : current,
        );
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : `${describe} failed`);
      } finally {
        setUpdating(false);
      }
    },
    [toast, updating],
  );

  const assign = useCallback(
    (memberId: string | null) =>
      void mutate(async (conversationId) => {
        const result = await api.post<{ assignedMemberId: string | null }>(
          `/conversations/${conversationId}/assign`,
          { memberId },
        );
        toast.success(memberId ? 'Conversation assigned' : 'Conversation unassigned');
        return { assignedMemberId: result.data.assignedMemberId };
      }, 'Assigning'),
    [mutate, toast],
  );

  const setStatus = useCallback(
    (status: 'open' | 'pending' | 'closed') =>
      void mutate(async (conversationId) => {
        const result = await api.patch<{ status: ConversationDto['status'] }>(
          `/conversations/${conversationId}`,
          { status },
        );
        toast.success(
          status === 'closed'
            ? 'Conversation closed'
            : status === 'pending'
              ? 'Marked as pending'
              : 'Conversation reopened',
        );
        return {
          status: result.data.status,
          closedAt: status === 'closed' ? new Date().toISOString() : null,
        };
      }, 'Changing the status'),
    [mutate, toast],
  );

  const setPriority = useCallback(
    (priority: ConversationDto['priority']) =>
      void mutate(async (conversationId) => {
        await api.patch(`/conversations/${conversationId}`, { priority });
        return { priority };
      }, 'Changing the priority'),
    [mutate],
  );

  const setTags = useCallback(
    (tags: string[]) =>
      void mutate(async (conversationId) => {
        await api.patch(`/conversations/${conversationId}`, { tags });
        return { tags };
      }, 'Updating tags'),
    [mutate],
  );

  // --- render -------------------------------------------------------------

  const live = connection === 'connected';
  const filtered =
    filters.status !== DEFAULT_FILTERS.status ||
    filters.assigned !== 'any' ||
    filters.propertyId !== 'all' ||
    filters.search !== '' ||
    filters.tags.length > 0;

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[420px] flex-col">
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
      </div>

      <div className="mb-3">
        <FilterBar
          filters={filters}
          properties={properties}
          knownTags={knownTags}
          resultCount={listLoading ? null : conversations.length}
          onChange={(next) => {
            setSelectedId(null);
            setSelectedConversation(null);
            selectedRef.current = null;
            setFilters(next);
          }}
        />
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
                title={filtered ? 'Nothing matches' : 'No conversations yet'}
                description={
                  filtered
                    ? 'Try a different status, a different owner, or clear the search.'
                    : 'When a visitor starts a chat on one of your sites, it appears here straight away.'
                }
              />
            </div>
          ) : (
            <>
              <ConversationList
                conversations={conversations}
                selectedId={selectedId}
                onlineVisitors={onlineVisitors}
                onSelect={(conversation) => void openConversation(conversation)}
              />
              {cursor && (
                <div className="p-3">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    className="w-full rounded-[var(--radius-control)] border border-border-strong py-2 text-[12px] font-medium text-ink-muted hover:bg-surface-raised disabled:opacity-50"
                  >
                    {loadingMore ? 'Loading…' : 'Load older conversations'}
                  </button>
                </div>
              )}
            </>
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
              <ConversationHeader
                conversation={selected}
                members={members}
                online={onlineVisitors.has(selected.visitor.id)}
                busy={updating}
                onAssign={assign}
                onStatus={setStatus}
                onPriority={setPriority}
                onTags={setTags}
                onBack={() => {
                  setSelectedId(null);
                  setSelectedConversation(null);
                  selectedRef.current = null;
                }}
              />

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
