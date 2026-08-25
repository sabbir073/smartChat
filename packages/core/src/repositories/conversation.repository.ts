import type { Conversation, DatabaseOrTransaction, Message, Visitor } from '@smartchat/database';
import { toJson } from '@smartchat/database';
import { clampLimit, type CursorPage, type TenantContext } from '@smartchat/types';
import { afterCursor, encodeCursor, notDeleted, tenantScope } from './scope.js';

export interface CreateConversationInput {
  accountId: string;
  propertyId: string;
  visitorId: string;
  channel?: 'widget' | 'offline_form' | 'email' | 'api';
  preChat?: Record<string, unknown>;
  subject?: string | null;
}

export interface InsertMessageInput {
  accountId: string;
  propertyId: string;
  conversationId: string;
  clientMessageId?: string | null;
  senderType: 'visitor' | 'agent' | 'system' | 'bot';
  senderMemberId?: string | null;
  senderVisitorId?: string | null;
  type?: 'text' | 'file' | 'image' | 'system' | 'note';
  body: string;
  metadata?: Record<string, unknown>;
  now: Date;
}

export interface PersistedMessage {
  message: Message;
  conversation: Conversation;
  /** True when this call created the row; false when an identical retry was deduplicated. */
  created: boolean;
}

export type ConversationWithVisitor = Conversation & { visitor: Visitor };

/** A message with just enough of its sender to attribute it. */
export type MessageWithSender = Message & {
  sender: { displayName: string | null; user: { name: string } | null } | null;
};

export class ConversationRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  create(input: CreateConversationInput, now: Date): Promise<Conversation> {
    return this.db.conversation.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        visitorId: input.visitorId,
        channel: input.channel ?? 'widget',
        preChatData: toJson(input.preChat),
        subject: input.subject ?? null,
        startedAt: now,
        lastMessageAt: now,
      },
    });
  }

  /** Visitor-surface lookup: the account is pinned from the visitor's token, not from a request. */
  findForVisitor(
    accountId: string,
    visitorId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    return this.db.conversation.findFirst({
      where: { id: conversationId, accountId, visitorId, deletedAt: null },
    });
  }

  /** The visitor's most recent conversation, so reopening the widget resumes rather than restarts. */
  findLatestForVisitor(accountId: string, visitorId: string): Promise<Conversation | null> {
    return this.db.conversation.findFirst({
      where: { accountId, visitorId, deletedAt: null },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  findById(
    context: TenantContext,
    conversationId: string,
  ): Promise<ConversationWithVisitor | null> {
    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { propertyId: { in: [...context.propertyIds] } }
        : {};
    return this.db.conversation.findFirst({
      where: { id: conversationId, ...tenantScope(context), ...notDeleted(), ...restriction },
      include: { visitor: true },
    });
  }

  /** Find an already-stored message by the id its sender generated. The dedup lookup. */
  findByClientMessageId(conversationId: string, clientMessageId: string): Promise<Message | null> {
    return this.db.message.findFirst({
      where: { conversationId, clientMessageId },
    });
  }

  findConversationById(conversationId: string): Promise<Conversation | null> {
    return this.db.conversation.findUnique({ where: { id: conversationId } });
  }

  /**
   * Persist a message and advance the conversation, atomically.
   *
   * This is the heart of the delivery guarantee. The insert and the counter increment happen in
   * one statement pair inside the caller's transaction, so a message can never exist without a
   * sequence number and a conversation's `message_seq` can never run ahead of its messages.
   *
   * A unique violation on `(conversation_id, client_message_id)` - a retry after a lost
   * acknowledgement - is deliberately allowed to escape. Postgres aborts the entire transaction
   * on a constraint violation ("current transaction is aborted, commands ignored until end of
   * transaction block"), so nothing here can read the existing row to recover: every further
   * statement on this connection fails until the transaction ends. The caller catches it once the
   * transaction has rolled back and re-reads then. The rollback also returns the sequence number,
   * so the counter needs no repair.
   */
  async insertMessage(input: InsertMessageInput): Promise<PersistedMessage> {
    const isFromVisitor = input.senderType === 'visitor';
    /**
     * Messages that must not disturb either side's unread count.
     *
     * An internal note is invisible to the visitor. A system message ("this chat was ended") is
     * a record of something both sides just did, not a message anyone needs to catch up on -
     * counting it would put an unread badge on a conversation nobody has said anything new in.
     */
    const isSilent = input.type === 'note' || input.senderType === 'system';

    // Reserve the next sequence number by incrementing the counter and reading it back. The row
    // lock this takes is also what serialises concurrent sends within one conversation.
    const conversation = await this.db.conversation.update({
      where: { id: input.conversationId },
      data: {
        messageSeq: { increment: 1 },
        lastMessageAt: input.now,
        // Neither notes nor system messages touch anything either side observes as "new" -
        // not an unread count, and not "last agent replied".
        ...(isSilent
          ? {}
          : isFromVisitor
            ? {
                lastVisitorMessageAt: input.now,
                agentUnreadCount: { increment: 1 },
              }
            : {
                lastAgentMessageAt: input.now,
                visitorUnreadCount: { increment: 1 },
              }),
      },
    });

    const message = await this.db.message.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        conversationId: input.conversationId,
        seq: conversation.messageSeq,
        clientMessageId: input.clientMessageId ?? null,
        senderType: input.senderType,
        senderMemberId: input.senderMemberId ?? null,
        senderVisitorId: input.senderVisitorId ?? null,
        type: input.type ?? 'text',
        body: input.body,
        metadata: toJson(input.metadata),
        createdAt: input.now,
      },
    });
    return { message, conversation, created: true };
  }

  /** Record the first agent reply once, and never overwrite it. */
  async recordFirstResponse(conversationId: string, now: Date): Promise<void> {
    await this.db.conversation.updateMany({
      where: { id: conversationId, firstResponseAt: null },
      data: { firstResponseAt: now },
    });
  }

  listMessages(
    conversationId: string,
    options: { beforeSeq?: number | undefined; limit: number; includeNotes: boolean },
  ): Promise<MessageWithSender[]> {
    return this.db.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        // A visitor must never receive an internal note, so this is enforced in the query rather
        // than filtered afterwards.
        ...(options.includeNotes ? {} : { type: { not: 'note' } }),
        ...(options.beforeSeq !== undefined ? { seq: { lt: BigInt(options.beforeSeq) } } : {}),
      },
      /**
       * The sender's name, so replayed history reads the same as live delivery.
       *
       * Without this a reload turns every agent reply anonymous: `senderName` is only known at
       * send time, from the sender's own request context, and history has no such context. Only
       * the display name and the user's name are selected - nothing else about the member or the
       * user belongs in a message payload.
       */
      include: {
        sender: { select: { displayName: true, user: { select: { name: true } } } },
      },
      orderBy: { seq: 'desc' },
      take: clampLimit(options.limit),
    });
  }

  /** Replay after a reconnect: everything the client has not seen, in order. */
  messagesSince(
    conversationId: string,
    lastSeq: number,
    includeNotes: boolean,
    limit = 200,
  ): Promise<MessageWithSender[]> {
    return this.db.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        seq: { gt: BigInt(lastSeq) },
        ...(includeNotes ? {} : { type: { not: 'note' } }),
      },
      /**
       * The sender's name, so replayed history reads the same as live delivery.
       *
       * Without this a reload turns every agent reply anonymous: `senderName` is only known at
       * send time, from the sender's own request context, and history has no such context. Only
       * the display name and the user's name are selected - nothing else about the member or the
       * user belongs in a message payload.
       */
      include: {
        sender: { select: { displayName: true, user: { select: { name: true } } } },
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async list(
    context: TenantContext,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      status?: 'open' | 'pending' | 'closed' | undefined;
      propertyId?: string | undefined;
      assignedMemberId?: string | null | undefined;
      search?: string | undefined;
      tags?: string[] | undefined;
    },
  ): Promise<CursorPage<ConversationWithVisitor>> {
    const limit = clampLimit(query.limit);
    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { propertyId: { in: [...context.propertyIds] } }
        : {};

    const rows = await this.db.conversation.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        ...restriction,
        ...(query.status ? { status: query.status } : {}),
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
        ...(query.assignedMemberId === null
          ? { assignedMemberId: null }
          : query.assignedMemberId
            ? { assignedMemberId: query.assignedMemberId }
            : {}),
        // Every tag must be present, not any: filters narrow.
        ...(query.tags && query.tags.length > 0 ? { tags: { hasEvery: query.tags } } : {}),
        // Agents search for what was said at least as often as for who said it, so the message
        // body is part of the search. Every column here has a trigram index; see schema.prisma.
        ...(query.search
          ? {
              OR: [
                { subject: { contains: query.search, mode: 'insensitive' } },
                { visitor: { name: { contains: query.search, mode: 'insensitive' } } },
                { visitor: { email: { contains: query.search, mode: 'insensitive' } } },
                {
                  messages: {
                    some: {
                      body: { contains: query.search, mode: 'insensitive' },
                      deletedAt: null,
                    },
                  },
                },
              ],
            }
          : {}),
        ...afterCursor(query.cursor),
      },
      include: { visitor: true },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      meta: {
        cursor: hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
        hasMore,
      },
    };
  }

  async update(
    context: TenantContext,
    conversationId: string,
    data: Record<string, unknown>,
  ): Promise<Conversation | null> {
    const result = await this.db.conversation.updateMany({
      where: { id: conversationId, ...tenantScope(context), ...notDeleted() },
      data,
    });
    if (result.count === 0) return null;
    return this.db.conversation.findFirst({
      where: { id: conversationId, ...tenantScope(context) },
    });
  }

  /**
   * Update a conversation on the visitor's behalf.
   *
   * Scoped by `visitorId` rather than by a TenantContext, because a visitor has no membership and
   * therefore no context. The visitor id comes from the signed token, never from the payload.
   */
  async updateForVisitor(
    accountId: string,
    conversationId: string,
    data: Record<string, unknown>,
  ): Promise<Conversation | null> {
    const result = await this.db.conversation.updateMany({
      where: { id: conversationId, accountId, deletedAt: null },
      data,
    });
    if (result.count === 0) return null;
    return this.db.conversation.findFirst({ where: { id: conversationId, accountId } });
  }

  /** Clear the visitor's unread counter. Called when the panel is open and caught up. */
  async markVisitorRead(accountId: string, conversationId: string): Promise<void> {
    await this.db.conversation.updateMany({
      where: { id: conversationId, accountId },
      data: { visitorUnreadCount: 0 },
    });
  }

  async markAgentRead(
    context: TenantContext,
    conversationId: string,
    memberId: string,
    seq: number,
    now: Date,
  ): Promise<void> {
    await this.db.conversationRead.upsert({
      where: { conversationId_memberId: { conversationId, memberId } },
      update: { lastReadSeq: BigInt(seq), readAt: now },
      create: {
        accountId: context.accountId,
        conversationId,
        memberId,
        lastReadSeq: BigInt(seq),
        readAt: now,
      },
    });
    await this.db.conversation.updateMany({
      where: { id: conversationId, ...tenantScope(context) },
      data: { agentUnreadCount: 0 },
    });
  }

  countOpen(context: TenantContext): Promise<number> {
    return this.db.conversation.count({
      where: { ...tenantScope(context), ...notDeleted(), status: 'open' },
    });
  }
}
