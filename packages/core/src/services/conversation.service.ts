import type { Conversation, Database, Message } from '@smartchat/database';
import { ActorType as DbActorType, isUniqueViolation } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  Permission,
  ServerEvent,
  room,
  type CursorPage,
  type TenantContext,
} from '@smartchat/types';
import type {
  ListConversationsInput,
  SendMessageInput,
  StartConversationInput,
  UpdateConversationInput,
} from '@smartchat/validation';
import { AuditRepository } from '../repositories/audit.repository.js';
import {
  ConversationRepository,
  type ConversationWithVisitor,
  type PersistedMessage,
} from '../repositories/conversation.repository.js';
import { VisitorRepository } from '../repositories/visitor.repository.js';
import { toMessageDto, type EventPublisher, type MessageDto } from '../realtime/events.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

export interface VisitorIdentity {
  accountId: string;
  propertyId: string;
  visitorId: string;
  sessionId: string;
  visitorName?: string | null;
}

export interface ConversationServiceOptions {
  db: Database;
  events: EventPublisher;
  clock?: Clock;
}

export interface SendResult {
  message: MessageDto;
  conversation: Conversation;
  /** False when an identical message had already been stored - a retry, not a duplicate. */
  created: boolean;
}

export class ConversationService {
  private readonly clock: Clock;
  private readonly repo: ConversationRepository;
  private readonly visitors: VisitorRepository;
  private readonly audit: AuditRepository;

  constructor(private readonly options: ConversationServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.repo = new ConversationRepository(options.db);
    this.visitors = new VisitorRepository(options.db);
    this.audit = new AuditRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Visitor side
  // ---------------------------------------------------------------------------

  /**
   * Start a conversation, or continue the visitor's existing open one.
   *
   * Continuing rather than always starting fresh is deliberate: a visitor who closes the widget
   * and comes back an hour later expects their conversation, not a new thread that an agent has to
   * mentally stitch together.
   */
  async startOrContinue(
    identity: VisitorIdentity,
    input: StartConversationInput,
  ): Promise<{ conversation: Conversation; message: MessageDto; isNew: boolean }> {
    const now = this.clock.now();

    const existing = await this.repo.findLatestForVisitor(identity.accountId, identity.visitorId);
    const reusable = existing && existing.status !== 'closed' ? existing : null;

    const conversation =
      reusable ??
      (await this.repo.create(
        {
          accountId: identity.accountId,
          propertyId: identity.propertyId,
          visitorId: identity.visitorId,
          channel: 'widget',
          ...(input.preChat ? { preChat: input.preChat } : {}),
        },
        now,
      ));

    // Pre-chat answers that arrive with the first message are traits about the person, so they are
    // attached to the visitor as well as the conversation.
    if (input.preChat && !reusable) {
      const traits = input.preChat;
      await this.visitors.identify(identity.accountId, identity.visitorId, {
        ...(typeof traits['name'] === 'string' ? { name: traits['name'] } : {}),
        ...(typeof traits['email'] === 'string' ? { email: traits['email'] } : {}),
        ...(typeof traits['phone'] === 'string' ? { phone: traits['phone'] } : {}),
      });
    }

    const result = await this.persistVisitorMessage(identity, conversation.id, {
      clientMessageId: input.clientMessageId,
      body: input.body,
      type: 'text',
    });

    if (!reusable) {
      await this.options.events.publish({
        type: ServerEvent.CONVERSATION_CREATED,
        accountId: identity.accountId,
        propertyId: identity.propertyId,
        conversationId: conversation.id,
        visitorId: identity.visitorId,
        payload: { conversationId: conversation.id },
      });
    }

    return { conversation: result.conversation, message: result.message, isNew: !reusable };
  }

  async sendVisitorMessage(
    identity: VisitorIdentity,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const conversation = await this.repo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      conversationId,
    );
    // A visitor asking for a conversation that is not theirs gets the same answer as one asking
    // for a conversation that does not exist.
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
    // A visitor can never write an internal note, whatever they send.
    return this.persistVisitorMessage(identity, conversationId, { ...input, type: 'text' });
  }

  /**
   * Run an insert with retry-safety around it.
   *
   * A resent message must produce the message that already exists, not a duplicate and not an
   * error. Both halves of that live here rather than in the repository because the recovery read
   * has to happen *outside* the transaction: Postgres aborts a transaction the moment a
   * constraint is violated, so a read on the same connection would fail with 25P02.
   *
   * The pre-check catches the ordinary case (a client resending after a lost ack) without
   * touching the sequence counter at all. The catch catches the race - two retries in flight at
   * once - where the pre-check found nothing but the insert lost to its twin.
   */
  private async insertWithRetrySafety(
    conversationId: string,
    clientMessageId: string | undefined,
    insert: (repo: ConversationRepository) => Promise<PersistedMessage>,
  ): Promise<PersistedMessage> {
    if (clientMessageId) {
      const existing = await this.repo.findByClientMessageId(conversationId, clientMessageId);
      if (existing) {
        const conversation = await this.repo.findConversationById(conversationId);
        if (conversation) return { message: existing, conversation, created: false };
      }
    }

    try {
      return await this.options.db.$transaction((tx) => insert(new ConversationRepository(tx)));
    } catch (error) {
      if (!clientMessageId || !isUniqueViolation(error, 'client_message_id')) throw error;

      // The transaction has rolled back by now, so this read runs on a healthy connection - and
      // the sequence number the rolled-back insert reserved has been returned automatically.
      const existing = await this.repo.findByClientMessageId(conversationId, clientMessageId);
      const conversation = await this.repo.findConversationById(conversationId);
      if (existing && conversation) return { message: existing, conversation, created: false };
      throw error;
    }
  }

  private async persistVisitorMessage(
    identity: VisitorIdentity,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const now = this.clock.now();

    const persisted = await this.insertWithRetrySafety(
      conversationId,
      input.clientMessageId,
      (repo) =>
        repo.insertMessage({
          accountId: identity.accountId,
          propertyId: identity.propertyId,
          conversationId,
          clientMessageId: input.clientMessageId,
          senderType: 'visitor',
          senderVisitorId: identity.visitorId,
          type: 'text',
          body: input.body,
          now,
        }),
    );

    const dto = toMessageDto(persisted.message, identity.visitorName ?? null);

    // Only a genuinely new message is broadcast. Re-broadcasting a deduplicated retry would show
    // the message twice in every agent's open inbox.
    if (persisted.created) {
      await this.options.events.publish({
        type: ServerEvent.MESSAGE_NEW,
        accountId: identity.accountId,
        propertyId: identity.propertyId,
        conversationId,
        visitorId: identity.visitorId,
        payload: { message: dto, room: room.conversation(conversationId) },
      });
    }

    return { message: dto, conversation: persisted.conversation, created: persisted.created };
  }

  async visitorHistory(
    identity: VisitorIdentity,
    conversationId: string,
    options: { beforeSeq?: number | undefined; limit?: number | undefined },
  ): Promise<MessageDto[]> {
    const conversation = await this.repo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      conversationId,
    );
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);

    const messages = await this.repo.listMessages(conversationId, {
      beforeSeq: options.beforeSeq,
      limit: options.limit ?? 50,
      // Never. Internal notes are invisible to the visitor by construction, not by filtering.
      includeNotes: false,
    });
    return messages.reverse().map((message) => toMessageDto(message));
  }

  /** Replay everything the visitor's client has not seen. Used on reconnect. */
  async visitorSync(
    identity: VisitorIdentity,
    conversationId: string,
    lastSeq: number,
  ): Promise<MessageDto[]> {
    const conversation = await this.repo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      conversationId,
    );
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
    const messages = await this.repo.messagesSince(conversationId, lastSeq, false);
    return messages.map((message) => toMessageDto(message));
  }

  async findVisitorConversation(identity: VisitorIdentity): Promise<Conversation | null> {
    return this.repo.findLatestForVisitor(identity.accountId, identity.visitorId);
  }

  async markVisitorRead(identity: VisitorIdentity, conversationId: string): Promise<void> {
    const conversation = await this.repo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      conversationId,
    );
    if (!conversation) return;
    await this.repo.markVisitorRead(identity.accountId, conversationId);
  }

  // ---------------------------------------------------------------------------
  // Agent side
  // ---------------------------------------------------------------------------

  async list(
    context: TenantContext,
    query: ListConversationsInput,
  ): Promise<CursorPage<ConversationWithVisitor>> {
    const memberId = this.requireMemberId(context);
    // An agent without the "view all" permission sees only what is assigned to them, whatever
    // filter they ask for.
    const restrictedToOwn = !context.permissions.has(Permission.CONVERSATION_VIEW_ALL);
    if (restrictedToOwn) requirePermission(context, Permission.CONVERSATION_VIEW_ASSIGNED);

    const assignedMemberId = restrictedToOwn
      ? memberId
      : query.assigned === 'me'
        ? memberId
        : query.assigned === 'unassigned'
          ? null
          : query.assignedMemberId;

    return this.repo.list(context, {
      cursor: query.cursor,
      limit: query.limit,
      status: query.status,
      propertyId: query.propertyId,
      assignedMemberId,
      search: query.search,
    });
  }

  async get(context: TenantContext, conversationId: string): Promise<ConversationWithVisitor> {
    const conversation = await this.repo.findById(context, conversationId);
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
    requirePropertyAccess(context, conversation.propertyId, ErrorCode.CONVERSATION_NOT_FOUND);
    this.assertCanSee(context, conversation);
    return conversation;
  }

  async agentHistory(
    context: TenantContext,
    conversationId: string,
    options: { beforeSeq?: number | undefined; limit?: number | undefined },
  ): Promise<MessageDto[]> {
    await this.get(context, conversationId);
    const messages = await this.repo.listMessages(conversationId, {
      beforeSeq: options.beforeSeq,
      limit: options.limit ?? 50,
      includeNotes: true,
    });
    return messages.reverse().map((message) => toMessageDto(message));
  }

  async agentSync(
    context: TenantContext,
    conversationId: string,
    lastSeq: number,
  ): Promise<MessageDto[]> {
    await this.get(context, conversationId);
    const messages = await this.repo.messagesSince(conversationId, lastSeq, true);
    return messages.map((message) => toMessageDto(message));
  }

  async sendAgentMessage(
    context: TenantContext,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const memberId = this.requireMemberId(context);
    const conversation = await this.get(context, conversationId);
    const isNote = input.type === 'note';

    requirePermission(
      context,
      isNote ? Permission.CONVERSATION_NOTE : Permission.CONVERSATION_REPLY,
    );
    if (!isNote && conversation.status === 'closed') {
      throw new AppError(ErrorCode.CONVERSATION_CLOSED, 'Reopen this conversation to reply');
    }

    const now = this.clock.now();
    const persisted = await this.insertWithRetrySafety(
      conversationId,
      input.clientMessageId,
      (repo) =>
        repo.insertMessage({
          accountId: context.accountId,
          propertyId: conversation.propertyId,
          conversationId,
          clientMessageId: input.clientMessageId,
          senderType: 'agent',
          senderMemberId: memberId,
          type: isNote ? 'note' : 'text',
          body: input.body,
          now,
        }),
    );

    if (persisted.created && !isNote) {
      await this.repo.recordFirstResponse(conversationId, now);
    }

    const dto = toMessageDto(persisted.message, context.actorName ?? null);

    if (persisted.created) {
      await this.options.events.publish({
        type: ServerEvent.MESSAGE_NEW,
        accountId: context.accountId,
        propertyId: conversation.propertyId,
        conversationId,
        visitorId: conversation.visitorId,
        // An internal note goes to agent rooms only. This flag is the single point that decides
        // it, so there is one place to be right.
        agentsOnly: isNote,
        payload: { message: dto, room: room.conversation(conversationId) },
        ...(context.requestId ? { requestId: context.requestId } : {}),
      });
    }

    return { message: dto, conversation: persisted.conversation, created: persisted.created };
  }

  async update(
    context: TenantContext,
    conversationId: string,
    input: UpdateConversationInput,
  ): Promise<Conversation> {
    const memberId = this.requireMemberId(context);
    const conversation = await this.get(context, conversationId);
    const now = this.clock.now();

    if (input.status !== undefined) {
      requirePermission(context, Permission.CONVERSATION_CLOSE);
    }
    if (input.tags !== undefined) {
      requirePermission(context, Permission.CONVERSATION_TAG);
    }

    const data: Record<string, unknown> = {};
    if (input.status !== undefined) {
      data['status'] = input.status;
      data['closedAt'] = input.status === 'closed' ? now : null;
      data['closedByMemberId'] = input.status === 'closed' ? memberId : null;
    }
    if (input.priority !== undefined) data['priority'] = input.priority;
    if (input.tags !== undefined) data['tags'] = input.tags;
    if (input.subject !== undefined) data['subject'] = input.subject;

    const updated = await this.repo.update(context, conversationId, data);
    if (!updated) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);

    await this.options.events.publish({
      type:
        input.status === 'closed'
          ? ServerEvent.CONVERSATION_CLOSED
          : ServerEvent.CONVERSATION_UPDATED,
      accountId: context.accountId,
      propertyId: conversation.propertyId,
      conversationId,
      visitorId: conversation.visitorId,
      payload: {
        conversationId,
        status: updated.status,
        priority: updated.priority,
        tags: updated.tags,
      },
    });

    return updated;
  }

  async assign(
    context: TenantContext,
    conversationId: string,
    assigneeMemberId: string | null,
  ): Promise<Conversation> {
    requirePermission(context, Permission.CONVERSATION_ASSIGN);
    const conversation = await this.get(context, conversationId);

    if (assigneeMemberId) {
      // The assignee must be a real member of *this* account. Without this check, an id from
      // another account would be written straight into the row.
      const member = await this.options.db.accountMember.findFirst({
        where: { id: assigneeMemberId, accountId: context.accountId, deletedAt: null },
        select: { id: true },
      });
      if (!member) throw new AppError(ErrorCode.MEMBER_NOT_FOUND);
    }

    const updated = await this.repo.update(context, conversationId, {
      assignedMemberId: assigneeMemberId,
    });
    if (!updated) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'conversation.assigned',
      resourceType: 'conversation',
      resourceId: conversationId,
      ip: context.ip ?? null,
      metadata: { assignedMemberId: assigneeMemberId },
    });

    await this.options.events.publish({
      type: ServerEvent.CONVERSATION_ASSIGNED,
      accountId: context.accountId,
      propertyId: conversation.propertyId,
      conversationId,
      agentsOnly: true,
      payload: { conversationId, assignedMemberId: assigneeMemberId },
    });

    return updated;
  }

  async markAgentRead(context: TenantContext, conversationId: string, seq: number): Promise<void> {
    const memberId = this.requireMemberId(context);
    await this.get(context, conversationId);
    await this.repo.markAgentRead(context, conversationId, memberId, seq, this.clock.now());
  }

  /**
   * Every agent action is attributed to a membership, not a user.
   *
   * An API-key or system actor has no membership and therefore cannot perform these actions; that
   * is a deliberate limitation rather than an oversight.
   */
  private requireMemberId(context: TenantContext): string {
    if (!context.memberId) {
      throw new AppError(ErrorCode.FORBIDDEN, 'This action requires a team member account');
    }
    return context.memberId;
  }

  /**
   * An agent restricted to their own conversations may not read someone else's, even by id.
   * Returning "not found" rather than "forbidden" keeps the inbox from leaking its own contents.
   */
  private assertCanSee(context: TenantContext, conversation: Conversation): void {
    if (context.permissions.has(Permission.CONVERSATION_VIEW_ALL)) return;
    if (
      context.permissions.has(Permission.CONVERSATION_VIEW_ASSIGNED) &&
      conversation.assignedMemberId &&
      // The membership id, not the user id: the same person in two accounts is two memberships.
      conversation.assignedMemberId === context.memberId
    ) {
      return;
    }
    if (
      context.permissions.has(Permission.CONVERSATION_VIEW_ASSIGNED) &&
      !conversation.assignedMemberId
    ) {
      // Unassigned conversations are visible to anyone who can pick one up; that is the queue.
      return;
    }
    throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
  }
}

export type { Message };
