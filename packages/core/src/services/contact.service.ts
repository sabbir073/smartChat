import type { Contact, ContactFieldDefinition, Database, Visitor } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  Permission,
  type CursorPage,
  type TenantContext,
} from '@smartchat/types';
import {
  collectCustomFields,
  type CreateContactFieldInput,
  type ListContactsInput,
  type UpdateContactFieldInput,
  type UpdateContactInput,
} from '@smartchat/validation';
import { AuditRepository } from '../repositories/audit.repository.js';
import { AttachmentRepository } from '../repositories/attachment.repository.js';
import { encodeCursor, afterCursor, notDeleted, tenantScope } from '../repositories/scope.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

export type ContactWithVisitors = Contact & { visitors: Visitor[] };

export interface ContactHistory {
  contact: ContactWithVisitors;
  conversations: {
    id: string;
    propertyId: string;
    status: string;
    subject: string | null;
    channel: string;
    startedAt: string;
    lastMessageAt: string;
    messageCount: number;
  }[];
  files: {
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    conversationId: string;
    createdAt: string;
  }[];
}

export interface ContactServiceOptions {
  db: Database;
  clock?: Clock;
}

/**
 * People, as opposed to browsers.
 *
 * A `Visitor` is one browser on one website. A contact is the person behind however many of those
 * there turn out to be, and the two are joined the moment an email address appears - from the
 * pre-chat form, the offline form, or a `SmartChat('identify')` call on the customer's own site.
 *
 * The join is explicit rather than implied by a query, which matters for what an agent is told:
 * "these four visits are the same person, because they all gave us this address" is a claim we can
 * show and defend, where "these visits look similar" is a guess dressed up as a fact.
 */
export class ContactService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;
  private readonly attachments: AttachmentRepository;

  constructor(private readonly options: ContactServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
    this.attachments = new AttachmentRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async list(
    context: TenantContext,
    query: ListContactsInput,
  ): Promise<CursorPage<ContactWithVisitors>> {
    requirePermission(context, Permission.CONTACT_VIEW);
    const limit = query.limit ?? 25;

    const rows = await this.options.db.contact.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search, mode: 'insensitive' } },
                { company: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...afterCursor(query.cursor),
      },
      include: { visitors: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      meta: {
        hasMore,
        cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      },
    };
  }

  async get(context: TenantContext, id: string): Promise<ContactWithVisitors> {
    requirePermission(context, Permission.CONTACT_VIEW);
    const contact = await this.options.db.contact.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
      include: { visitors: true },
    });
    if (!contact) throw new AppError(ErrorCode.CONTACT_NOT_FOUND);
    return contact;
  }

  /**
   * Everything this person has ever done with us.
   *
   * Assembled across every visitor identity that belongs to them, which is the point: somebody who
   * wrote in from their laptop last month and their phone today is one history, not two - and an
   * agent who cannot see that asks them to explain it all again.
   *
   * A restricted agent sees only the parts on websites they work on. The person is still whole;
   * the history is scoped, and that is the honest way round.
   */
  async history(context: TenantContext, id: string): Promise<ContactHistory> {
    const contact = await this.get(context, id);
    const visitorIds = contact.visitors.map((visitor) => visitor.id);
    if (visitorIds.length === 0) return { contact, conversations: [], files: [] };

    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { propertyId: { in: [...context.propertyIds] } }
        : {};

    const conversations = await this.options.db.conversation.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        ...restriction,
        visitorId: { in: visitorIds },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      select: {
        id: true,
        propertyId: true,
        status: true,
        subject: true,
        channel: true,
        startedAt: true,
        lastMessageAt: true,
        messageSeq: true,
      },
    });

    const files = await this.attachments.listForVisitors(context, visitorIds, 50);
    const visible = new Set(conversations.map((conversation) => conversation.id));

    return {
      contact,
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        propertyId: conversation.propertyId,
        status: conversation.status,
        subject: conversation.subject,
        channel: conversation.channel,
        startedAt: conversation.startedAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        messageCount: Number(conversation.messageSeq),
      })),
      // A file from a conversation this agent cannot see must not appear in the list either -
      // the property scope has to hold on every route out of the data, not just the obvious one.
      files: files
        .filter((file) => visible.has(file.conversationId))
        .map((file) => ({
          id: file.id,
          fileName: file.fileName,
          contentType: file.contentType,
          byteSize: file.byteSize,
          conversationId: file.conversationId,
          createdAt: file.createdAt.toISOString(),
        })),
    };
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  async update(
    context: TenantContext,
    id: string,
    input: UpdateContactInput,
  ): Promise<ContactWithVisitors> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const existing = await this.get(context, id);

    const data: Record<string, unknown> = {};
    for (const field of ['name', 'email', 'phone', 'company', 'notes'] as const) {
      if (input[field] !== undefined) data[field] = input[field];
    }

    if (input.customFields) {
      const definitions = await this.listFields(context);
      const collected = collectCustomFields(definitions, input.customFields);
      if (collected.invalid.length > 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Please check those fields', {
          details: collected.invalid.map((label) => ({
            path: label,
            message: `${label} is not valid`,
          })),
        });
      }
      // Merged, not replaced: a form that submits one field must not erase the others.
      const current = (existing.customFields ?? {}) as Record<string, string>;
      data['customFields'] = { ...current, ...collected.values };
    }

    const changed = await this.options.db.contact.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data,
    });
    if (changed.count === 0) throw new AppError(ErrorCode.CONTACT_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'contact.updated',
      resourceType: 'contact',
      resourceId: id,
      ip: context.ip ?? null,
      metadata: { fields: Object.keys(data) },
    });

    return this.get(context, id);
  }

  // ---------------------------------------------------------------------------
  // Field definitions
  // ---------------------------------------------------------------------------

  async listFields(context: TenantContext): Promise<ContactFieldDefinition[]> {
    requirePermission(context, Permission.CONTACT_VIEW);
    return this.options.db.contactFieldDefinition.findMany({
      where: { ...tenantScope(context), ...notDeleted() },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createField(
    context: TenantContext,
    input: CreateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const existing = await this.options.db.contactFieldDefinition.findFirst({
      where: { accountId: context.accountId, key: input.key },
    });
    if (existing) {
      // A deleted field with the same key is revived rather than duplicated, so the values already
      // stored against that key come back with it.
      if (!existing.deletedAt) {
        throw new AppError(ErrorCode.CONFLICT, 'A field with that name already exists');
      }
      return this.options.db.contactFieldDefinition.update({
        where: { id: existing.id },
        data: {
          label: input.label,
          type: input.type,
          options: input.options,
          position: input.position,
          deletedAt: null,
        },
      });
    }

    return this.options.db.contactFieldDefinition.create({
      data: {
        accountId: context.accountId,
        key: input.key,
        label: input.label,
        type: input.type,
        options: input.options,
        position: input.position,
      },
    });
  }

  async updateField(
    context: TenantContext,
    id: string,
    input: UpdateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const changed = await this.options.db.contactFieldDefinition.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data: input,
    });
    if (changed.count === 0) throw new AppError(ErrorCode.NOT_FOUND);
    const field = await this.options.db.contactFieldDefinition.findFirst({
      where: { ...tenantScope(context), id },
    });
    if (!field) throw new AppError(ErrorCode.NOT_FOUND);
    return field;
  }

  /**
   * Remove a field definition.
   *
   * Soft, and the values stay on the contacts. Deleting a column of somebody's CRM because a
   * field was renamed is not a recoverable mistake, and reviving the key brings the data back.
   */
  async deleteField(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.CONTACT_UPDATE);
    const changed = await this.options.db.contactFieldDefinition.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data: { deletedAt: this.clock.now() },
    });
    if (changed.count === 0) throw new AppError(ErrorCode.NOT_FOUND);
  }
}
