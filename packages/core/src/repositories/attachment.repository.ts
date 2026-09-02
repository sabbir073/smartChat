import type { Attachment, DatabaseOrTransaction } from '@smartchat/database';
import type { TenantContext } from '@smartchat/types';
import { notDeleted, tenantScope } from './scope.js';

export interface CreatePendingAttachment {
  accountId: string;
  propertyId: string;
  conversationId: string;
  uploaderType: 'visitor' | 'agent';
  uploaderMemberId: string | null;
  uploaderVisitorId: string | null;
  storageKey: string;
  bucket: string;
  fileName: string;
  /** What the client said it was sending. Recorded as the declared size, never as the truth. */
  byteSize: number;
}

export class AttachmentRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  create(input: CreatePendingAttachment): Promise<Attachment> {
    return this.db.attachment.create({
      data: {
        ...input,
        // A placeholder until the bytes have been read. Nothing serves a pending attachment, so
        // this value is never shown to anybody.
        contentType: 'application/octet-stream',
        status: 'pending',
      },
    });
  }

  /** Account-scoped rather than context-scoped: the visitor path has no member. */
  findById(accountId: string, id: string): Promise<Attachment | null> {
    return this.db.attachment.findFirst({ where: { accountId, id, deletedAt: null } });
  }

  markReady(
    id: string,
    data: {
      contentType: string;
      byteSize: number;
      checksum: string;
      fileName: string;
      confirmedAt: Date;
    },
  ): Promise<Attachment> {
    return this.db.attachment.update({
      where: { id },
      data: { ...data, status: 'ready', rejectionReason: null },
    });
  }

  markRejected(id: string, reason: string): Promise<Attachment> {
    return this.db.attachment.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: reason },
    });
  }

  attachToMessage(id: string, messageId: string): Promise<Attachment> {
    return this.db.attachment.update({ where: { id }, data: { messageId } });
  }

  /** Every ready file in a conversation, for rendering a thread. */
  listForConversation(accountId: string, conversationId: string): Promise<Attachment[]> {
    return this.db.attachment.findMany({
      where: { accountId, conversationId, status: 'ready', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Everything one person has ever sent us, across every conversation they have had. */
  listForVisitors(
    context: TenantContext,
    visitorIds: string[],
    limit: number,
  ): Promise<Attachment[]> {
    if (visitorIds.length === 0) return Promise.resolve([]);
    return this.db.attachment.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        status: 'ready',
        uploaderVisitorId: { in: visitorIds },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

