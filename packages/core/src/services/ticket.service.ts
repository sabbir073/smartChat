import type {
  AccountMember,
  Database,
  DatabaseTransaction,
  Ticket,
  TicketMessage,
} from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
  Permission,
  WebhookEvent,
  type CursorPage,
  type TenantContext,
} from '@smartchat/types';
import {
  subjectFromBody,
  type CreateTicketInput,
  type ListTicketsInput,
  type ReplyToTicketInput,
  type UpdateTicketInput,
} from '@smartchat/validation';
import type { MailMessage } from '../mail/provider.js';
import {
  ticketAssignedTemplate,
  ticketReceivedTemplate,
  ticketReplyTemplate,
  ticketResolvedTemplate,
  type BrandContext,
  type TicketMailContext,
} from '../mail/templates.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { afterCursor, encodeCursor, notDeleted, tenantScope } from '../repositories/scope.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import type { PlanGuard } from './plan-guard.js';
import type { WebhookEmitter } from './webhook.service.js';
import { systemClock, type Clock } from '../time.js';

export type TicketWithRelations = Ticket & {
  assignedMember?: (AccountMember & { user?: { name: string | null } | null }) | null;
  messages?: TicketMessage[];
};

/**
 * How an email actually leaves this service.
 *
 * The caller hands in a function rather than a queue, because "write the delivery row, then hand
 * the message to whatever transport exists" is the same in the API, in the worker and in a test -
 * and a service that imported BullMQ could not be tested without Redis.
 */
export type MailDeliver = (input: {
  message: MailMessage;
  template: string;
  accountId: string;
  ticketId?: string;
  ticketMessageId?: string;
}) => Promise<void>;

export interface TicketServiceOptions {
  db: Database;
  /** Required, not optional: an entitlement nobody is forced to wire up is one nobody wires up. */
  plan: PlanGuard;
  brand: BrandContext;
  deliver: MailDeliver;
  /** Outbound integrations. Optional so a test can build the service without one. */
  webhooks?: WebhookEmitter;
  clock?: Clock;
}

const PAGE_MAX = 100;

/**
 * Tickets: the asynchronous half of support.
 *
 * A conversation is answered in a widget somebody has open. A ticket is answered by email to
 * somebody who closed the tab an hour ago, and everything here follows from that difference - a
 * number they can quote, an address captured at the moment they wrote in, and one hard rule about
 * what leaves the building.
 *
 * **The rule.** A `public` ticket message is emailed to the requester. An `internal` one is not,
 * and there is exactly one place in this file where a message becomes an email. If that rule ever
 * breaks, an agent's private note about a customer is delivered to that customer, and no apology
 * repairs it. It is why `visibility` has no default anywhere in the contract, why the branch lives
 * next to the insert rather than in a caller, and why the e2e suite counts the messages in Mailpit
 * before and after an internal note.
 */
export class TicketService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: TicketServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async list(context: TenantContext, query: ListTicketsInput): Promise<CursorPage<Ticket>> {
    requirePermission(context, Permission.TICKET_VIEW);

    if (query.propertyId) {
      await assertPropertyInAccount(
        this.options.db,
        context,
        query.propertyId,
        ErrorCode.NOT_FOUND,
      );
    }
    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { propertyId: { in: [...context.propertyIds] } }
        : {};

    const assignment =
      query.assigned === 'me'
        ? { assignedMemberId: context.memberId ?? '' }
        : query.assigned === 'unassigned'
          ? { assignedMemberId: null }
          : query.assignedMemberId
            ? { assignedMemberId: query.assignedMemberId }
            : {};

    const limit = Math.min(query.limit, PAGE_MAX);
    const rows = await this.options.db.ticket.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        ...restriction,
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.contactId ? { contactId: query.contactId } : {}),
        ...assignment,
        // Two `OR` keys in one object silently replace each other, so a search combined with a
        // cursor is composed under `AND`. The same trap as the inbox; see ADR-031.
        AND: [
          afterCursor(query.cursor),
          ...(query.search
            ? [
                {
                  OR: [
                    { subject: { contains: query.search, mode: 'insensitive' as const } },
                    { requesterEmail: { contains: query.search, mode: 'insensitive' as const } },
                    ...(/^#?\d+$/.test(query.search)
                      ? [{ number: Number(query.search.replace('#', '')) }]
                      : []),
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      meta: {
        cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
    };
  }

  async get(context: TenantContext, id: string): Promise<TicketWithRelations> {
    requirePermission(context, Permission.TICKET_VIEW);
    const ticket = await this.options.db.ticket.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
      include: {
        assignedMember: { include: { user: { select: { name: true } } } },
      },
    });
    if (!ticket) throw new AppError(ErrorCode.TICKET_NOT_FOUND);
    // A ticket on a website this agent does not work on is not theirs to see, and saying "you are
    // not allowed" would still confirm it exists.
    requirePropertyAccess(context, ticket.propertyId, ErrorCode.TICKET_NOT_FOUND);
    return ticket;
  }

  /**
   * The thread.
   *
   * Internal notes are included - the caller is an agent of this account, which is the only
   * audience they were ever for.
   */
  async messages(context: TenantContext, id: string): Promise<TicketMessage[]> {
    await this.get(context, id);
    return this.options.db.ticketMessage.findMany({
      where: { ...tenantScope(context), ticketId: id, deletedAt: null },
      orderBy: [{ seq: 'asc' }],
    });
  }

  // ---------------------------------------------------------------------------
  // Creating
  // ---------------------------------------------------------------------------

  /**
   * Allocate the next number for an account.
   *
   * `UPDATE ... RETURNING` on the account row: atomic, and the row lock it takes serialises two
   * simultaneous ticket creations in the same account, which is exactly what "gapless and unique"
   * requires. A `SELECT max(number) + 1` would hand the same number to both.
   */
  private async nextNumber(tx: DatabaseTransaction, accountId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ ticket_seq: number }[]>`
      UPDATE accounts SET ticket_seq = ticket_seq + 1 WHERE id = ${accountId}::uuid
      RETURNING ticket_seq
    `;
    const next = rows[0]?.ticket_seq;
    if (next === undefined) throw new AppError(ErrorCode.NOT_FOUND);
    return Number(next);
  }

  async create(context: TenantContext, input: CreateTicketInput): Promise<Ticket> {
    requirePermission(context, Permission.TICKET_MANAGE);
    await this.options.plan.assertFeature(context, FeatureKey.FEATURE_TICKETS);
    await assertPropertyInAccount(this.options.db, context, input.propertyId, ErrorCode.NOT_FOUND);

    const now = this.clock.now();
    const contact = await this.options.db.contact.findFirst({
      where: { accountId: context.accountId, email: input.requesterEmail, deletedAt: null },
      select: { id: true },
    });

    const { ticket, first } = await this.options.db.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, context.accountId);
      const created = await tx.ticket.create({
        data: {
          accountId: context.accountId,
          propertyId: input.propertyId,
          number,
          contactId: contact?.id ?? null,
          requesterEmail: input.requesterEmail,
          requesterName: input.requesterName,
          subject: input.subject,
          priority: input.priority,
          assignedMemberId: input.assignedMemberId,
          departmentId: input.departmentId,
          tags: input.tags,
          createdByMemberId: context.memberId ?? null,
          messageSeq: 1,
          lastMessageAt: now,
        },
      });
      const message = await tx.ticketMessage.create({
        data: {
          accountId: context.accountId,
          ticketId: created.id,
          seq: 1,
          authorType: 'contact',
          visibility: 'public',
          body: input.body,
          createdAt: now,
        },
      });
      return { ticket: created, first: message };
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ticket.created',
      resourceType: 'ticket',
      resourceId: ticket.id,
      ip: context.ip ?? null,
      metadata: { number: ticket.number, subject: ticket.subject },
    });

    await this.emit(WebhookEvent.TICKET_CREATED, ticket, { body: input.body });

    if (input.notifyRequester) {
      await this.sendReceipt(ticket, input.body, first.id);
    }
    if (ticket.assignedMemberId) {
      await this.notifyAssignee(ticket, ticket.assignedMemberId);
    }

    return ticket;
  }

  /**
   * A ticket raised by the product itself, from an offline message.
   *
   * Deliberately not `create` with a synthetic context: there is no member here, no permission to
   * check and nobody to audit as the actor. Pretending a visitor's form submission was an agent
   * action would put a lie in the audit log.
   */
  async openFromOfflineMessage(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    visitorId: string;
    body: string;
    requesterEmail: string | null;
    requesterName: string | null;
  }): Promise<Ticket | null> {
    // Without an address there is nowhere to send an answer, and a ticket that cannot be answered
    // is a row that makes a queue look busier than it is. The conversation still exists in the
    // inbox, which is where that message gets handled.
    if (!input.requesterEmail) return null;
    // Captured before the transaction: narrowing on a parameter's property does not survive into
    // the closure below, and `requesterEmail!` would assert something the compiler is right to
    // doubt if this function ever grows a branch.
    const requesterEmail = input.requesterEmail;

    const now = this.clock.now();
    const visitor = await this.options.db.visitor.findFirst({
      where: { accountId: input.accountId, id: input.visitorId },
      select: { contactId: true },
    });

    const { ticket, first } = await this.options.db.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, input.accountId);
      const created = await tx.ticket.create({
        data: {
          accountId: input.accountId,
          propertyId: input.propertyId,
          number,
          contactId: visitor?.contactId ?? null,
          conversationId: input.conversationId,
          requesterEmail,
          requesterName: input.requesterName,
          subject: subjectFromBody(input.body),
          messageSeq: 1,
          lastMessageAt: now,
        },
      });
      const message = await tx.ticketMessage.create({
        data: {
          accountId: input.accountId,
          ticketId: created.id,
          seq: 1,
          authorType: 'contact',
          visibility: 'public',
          body: input.body,
          createdAt: now,
        },
      });
      return { ticket: created, first: message };
    });

    await this.audit.record({
      accountId: input.accountId,
      actorType: DbActorType.system,
      actorId: null,
      action: 'ticket.opened_from_offline_message',
      resourceType: 'ticket',
      resourceId: ticket.id,
      ip: null,
      metadata: { number: ticket.number, conversationId: input.conversationId },
    });

    await this.emit(WebhookEvent.TICKET_CREATED, ticket, {
      body: input.body,
      source: 'offline_form',
    });
    await this.sendReceipt(ticket, input.body, first.id);
    return ticket;
  }

  // ---------------------------------------------------------------------------
  // Working it
  // ---------------------------------------------------------------------------

  async update(context: TenantContext, id: string, input: UpdateTicketInput): Promise<Ticket> {
    requirePermission(context, Permission.TICKET_MANAGE);
    const existing = await this.get(context, id);

    if (input.assignedMemberId) {
      const member = await this.options.db.accountMember.findFirst({
        where: { accountId: context.accountId, id: input.assignedMemberId, deletedAt: null },
        select: { id: true },
      });
      if (!member)
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That person is not on this team');
    }

    const now = this.clock.now();
    const data: Record<string, unknown> = { ...input };

    /**
     * Status timestamps are set on the transition, not on every write.
     *
     * `resolvedAt` answers "when did we consider this done", so re-saving a resolved ticket after
     * editing its tags must not move it. Reopening clears both, because a ticket that is open
     * again was not resolved at any of the times it previously claimed.
     */
    if (input.status && input.status !== existing.status) {
      if (input.status === 'resolved') {
        data['resolvedAt'] = existing.resolvedAt ?? now;
        data['closedAt'] = null;
      } else if (input.status === 'closed') {
        data['closedAt'] = now;
        data['resolvedAt'] = existing.resolvedAt ?? now;
      } else {
        data['resolvedAt'] = null;
        data['closedAt'] = null;
      }
    }

    const ticket = await this.options.db.ticket.update({ where: { id }, data });

    if (
      input.assignedMemberId &&
      input.assignedMemberId !== existing.assignedMemberId &&
      input.assignedMemberId !== context.memberId
    ) {
      // Assigning work to yourself does not need an email telling you that you did.
      await this.notifyAssignee(ticket, input.assignedMemberId);
    }
    if (input.status && input.status !== existing.status) {
      await this.emit(WebhookEvent.TICKET_STATUS_CHANGED, ticket, {
        from: existing.status,
        to: ticket.status,
      });
    }
    if (input.status === 'resolved' && existing.status !== 'resolved') {
      await this.deliver(ticketResolvedTemplate(await this.mailContext(ticket)), {
        template: 'ticket.resolved',
        accountId: ticket.accountId,
        ticketId: ticket.id,
      });
    }

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ticket.updated',
      resourceType: 'ticket',
      resourceId: ticket.id,
      ip: context.ip ?? null,
      metadata: { number: ticket.number, changed: Object.keys(input) },
    });

    return ticket;
  }

  /**
   * Add a message to a ticket - and, if it is public, send it.
   *
   * The single place in this product where an agent's words leave the account. The branch is four
   * lines below the insert on purpose: whoever changes one has to look at the other.
   */
  async reply(
    context: TenantContext,
    id: string,
    input: ReplyToTicketInput,
  ): Promise<TicketMessage> {
    requirePermission(context, Permission.TICKET_MANAGE);
    const ticket = await this.get(context, id);
    if (ticket.status === 'closed') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This ticket is closed. Reopen it to reply.');
    }

    const now = this.clock.now();
    const isPublic = input.visibility === 'public';

    const message = await this.options.db.$transaction(async (tx) => {
      const claimed = await tx.ticket.update({
        where: { id },
        data: {
          messageSeq: { increment: 1 },
          ...(isPublic
            ? {
                lastMessageAt: now,
                // Recorded once. An internal note is not a response to the person waiting, so it
                // must never start this clock.
                ...(ticket.firstResponseAt ? {} : { firstResponseAt: now }),
                // Answering moves it to "waiting on them" unless somebody already decided
                // otherwise; a note leaves the status alone entirely.
                ...(ticket.status === 'open' ? { status: 'pending' as const } : {}),
              }
            : {}),
        },
        select: { messageSeq: true },
      });

      return tx.ticketMessage.create({
        data: {
          accountId: context.accountId,
          ticketId: id,
          seq: claimed.messageSeq,
          authorType: 'agent',
          authorMemberId: context.memberId ?? null,
          visibility: input.visibility,
          body: input.body,
          createdAt: now,
        },
      });
    });

    if (isPublic) {
      // Only a public reply. An internal note is not something that happened to the customer, and
      // an integration that mirrored notes into a shared channel would leak them by design.
      await this.emit(WebhookEvent.TICKET_REPLIED, ticket, {
        messageId: message.id,
        body: input.body,
        authorName: context.actorName ?? null,
      });
      await this.deliver(
        ticketReplyTemplate(await this.mailContext(ticket), {
          reply: input.body,
          agentName: context.actorName ?? 'Support',
        }),
        {
          template: 'ticket.reply',
          accountId: ticket.accountId,
          ticketId: ticket.id,
          ticketMessageId: message.id,
        },
      );
    }

    return message;
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.TICKET_MANAGE);
    await this.get(context, id);
    await this.options.db.ticket.update({
      where: { id },
      data: { deletedAt: this.clock.now() },
    });
  }

  // ---------------------------------------------------------------------------
  // Email
  // ---------------------------------------------------------------------------

  /**
   * Tell any subscribed integration, without ever failing the thing that happened.
   *
   * The ticket is already committed. A webhook table that is unreachable must not turn a saved
   * reply into a 500 that makes an agent retype it into a ticket that already has it.
   */
  private async emit(
    event: WebhookEvent,
    ticket: Ticket,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.options.webhooks) return;
    try {
      await this.options.webhooks.queue(ticket.accountId, event, {
        ticketId: ticket.id,
        number: ticket.number,
        propertyId: ticket.propertyId,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        requesterEmail: ticket.requesterEmail,
        requesterName: ticket.requesterName,
        ...extra,
      });
    } catch {
      // Deliberate. See above.
    }
  }

  private async mailContext(ticket: Ticket): Promise<TicketMailContext> {
    const [account, property] = await Promise.all([
      this.options.db.account.findUnique({
        where: { id: ticket.accountId },
        select: { name: true },
      }),
      this.options.db.property.findFirst({
        where: { accountId: ticket.accountId, id: ticket.propertyId },
        select: { supportEmail: true },
      }),
    ]);

    return {
      // The recipient is a customer of our customer. They have never heard of us, so the name on
      // the message is the one they recognise.
      accountName: account?.name ?? this.options.brand.productName,
      ticketNumber: ticket.number,
      subject: ticket.subject,
      requesterEmail: ticket.requesterEmail,
      requesterName: ticket.requesterName,
      supportEmail: property?.supportEmail ?? null,
    };
  }

  private async sendReceipt(ticket: Ticket, body: string, messageId: string): Promise<void> {
    await this.deliver(ticketReceivedTemplate(await this.mailContext(ticket), body), {
      template: 'ticket.received',
      accountId: ticket.accountId,
      ticketId: ticket.id,
      ticketMessageId: messageId,
    });
  }

  private async notifyAssignee(ticket: Ticket, memberId: string): Promise<void> {
    const member = await this.options.db.accountMember.findFirst({
      where: { accountId: ticket.accountId, id: memberId, deletedAt: null },
      select: { displayName: true, user: { select: { name: true, email: true } } },
    });
    if (!member?.user?.email) return;

    await this.deliver(
      ticketAssignedTemplate(this.options.brand, {
        memberEmail: member.user.email,
        memberName: member.displayName ?? member.user.name ?? 'there',
        ticketNumber: ticket.number,
        subject: ticket.subject,
        requesterName: ticket.requesterName ?? ticket.requesterEmail,
        url: `${this.options.brand.appUrl}/tickets/${ticket.id}`,
      }),
      { template: 'ticket.assigned', accountId: ticket.accountId, ticketId: ticket.id },
    );
  }

  /**
   * Hand a message to the transport, and never let that failure lose the work.
   *
   * The ticket and its message are already committed by the time this runs. If the queue is down,
   * the right outcome is a ticket that exists with an email that did not go - visible as a stuck
   * `queued` row - rather than a 500 that makes the agent retype their reply into a ticket that
   * already has it.
   */
  private async deliver(
    message: MailMessage,
    meta: { template: string; accountId: string; ticketId?: string; ticketMessageId?: string },
  ): Promise<void> {
    try {
      await this.options.deliver({ message, ...meta });
    } catch {
      // Swallowed on purpose; the delivery row records what happened. See the note above.
    }
  }
}
