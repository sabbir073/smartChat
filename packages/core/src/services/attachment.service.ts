import type { Attachment, Database } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { AttachmentRepository } from '../repositories/attachment.repository.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { attachmentKey, downloadName, safeFileName } from '../storage/keys.js';
import { identifyFile } from '../storage/signature.js';
import type { StorageService } from '../storage/storage.service.js';
import type { ConversationService, VisitorIdentity } from './conversation.service.js';
import type { MessageDto } from '../realtime/events.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

export interface AttachmentServiceOptions {
  db: Database;
  storage: StorageService;
  conversations: ConversationService;
  maxBytes: number;
  /**
   * The platform kill switch for uploads. Optional so tests need not wire one.
   * Checked in `sign`, which is the single point both the agent and the visitor path pass
   * through - gating the two callers separately would be two places to forget.
   */
  flags?: { assertEnabled(flag: 'uploads', accountId?: string): Promise<void> };
  clock?: Clock;
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
}

export function toAttachmentDto(attachment: Attachment): AttachmentDto {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    isImage: attachment.contentType.startsWith('image/'),
    width: attachment.width,
    height: attachment.height,
  };
}

export interface SignedUpload {
  attachmentId: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

/**
 * Uploads, from both sides.
 *
 * The shape of this is the whole security argument, so it is worth stating plainly:
 *
 *   1. The client asks for somewhere to put a file. We decide the key, from ids we generated.
 *   2. The client PUTs the bytes straight to object storage with a URL that authorises exactly
 *      that one write, for a few minutes.
 *   3. The client tells us it is done. *Then* we read the object back and find out what it
 *      actually is. Only after that does it exist as far as anybody else is concerned.
 *
 * Step 3 is the one that matters. Everything the client said in step 1 - the type, the size, the
 * name - is a claim, and none of it is trusted. A file that turns out to be something we do not
 * accept is deleted from the store and the row is marked rejected, so a signed URL cannot be used
 * to park arbitrary content in our bucket.
 */
export class AttachmentService {
  private readonly clock: Clock;
  private readonly repo: AttachmentRepository;
  private readonly conversationRepo: ConversationRepository;

  constructor(private readonly options: AttachmentServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.repo = new AttachmentRepository(options.db);
    this.conversationRepo = new ConversationRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Agent side
  // ---------------------------------------------------------------------------

  async signForAgent(
    context: TenantContext,
    input: { conversationId: string; fileName: string; byteSize: number },
  ): Promise<SignedUpload> {
    requirePermission(context, Permission.CONVERSATION_REPLY);
    const conversation = await this.options.conversations.get(context, input.conversationId);
    this.assertSize(input.byteSize);

    return this.sign({
      accountId: context.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      uploaderType: 'agent',
      uploaderMemberId: context.memberId ?? null,
      uploaderVisitorId: null,
      fileName: input.fileName,
      byteSize: input.byteSize,
    });
  }

  async confirmForAgent(
    context: TenantContext,
    attachmentId: string,
    input: { clientMessageId?: string | undefined; body?: string | undefined },
  ): Promise<{ message: MessageDto; attachment: AttachmentDto }> {
    requirePermission(context, Permission.CONVERSATION_REPLY);
    const attachment = await this.repo.findById(context.accountId, attachmentId);
    if (!attachment || attachment.uploaderMemberId !== (context.memberId ?? null)) {
      // Somebody else's upload is somebody else's business - the same answer as one that is not
      // there, so an id cannot be probed for existence.
      throw new AppError(ErrorCode.NOT_FOUND);
    }
    // Re-checked, because `get` is what enforces the property scope a restricted agent has.
    await this.options.conversations.get(context, attachment.conversationId);
    this.assertNotAlreadySent(attachment);

    const ready = await this.verify(attachment);
    const sent = await this.options.conversations.sendAgentMessage(context, ready.conversationId, {
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      body: input.body?.trim() || ready.fileName,
      type: ready.contentType.startsWith('image/') ? 'image' : 'file',
      attachmentId: ready.id,
      // Carried inline so the socket delivers the message and its file together.
      attachment: toAttachmentDto(ready),
    });

    await this.repo.attachToMessage(ready.id, sent.message.id);
    return { message: sent.message, attachment: toAttachmentDto(ready) };
  }

  // ---------------------------------------------------------------------------
  // Visitor side
  // ---------------------------------------------------------------------------

  async signForVisitor(
    identity: VisitorIdentity,
    input: { conversationId: string; fileName: string; byteSize: number },
  ): Promise<SignedUpload> {
    const conversation = await this.conversationRepo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      input.conversationId,
    );
    if (!conversation) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
    if (conversation.status === 'closed') throw new AppError(ErrorCode.CONVERSATION_CLOSED);
    this.assertSize(input.byteSize);

    return this.sign({
      accountId: identity.accountId,
      propertyId: identity.propertyId,
      conversationId: conversation.id,
      uploaderType: 'visitor',
      uploaderMemberId: null,
      uploaderVisitorId: identity.visitorId,
      fileName: input.fileName,
      byteSize: input.byteSize,
    });
  }

  async confirmForVisitor(
    identity: VisitorIdentity,
    attachmentId: string,
    input: { clientMessageId?: string | undefined },
  ): Promise<{ message: MessageDto; attachment: AttachmentDto }> {
    const attachment = await this.repo.findById(identity.accountId, attachmentId);
    if (!attachment || attachment.uploaderVisitorId !== identity.visitorId) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }
    this.assertNotAlreadySent(attachment);

    const ready = await this.verify(attachment);
    const sent = await this.options.conversations.sendVisitorMessage(
      identity,
      ready.conversationId,
      {
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        body: ready.fileName,
        type: ready.contentType.startsWith('image/') ? 'image' : 'file',
        attachmentId: ready.id,
        attachment: toAttachmentDto(ready),
      },
    );

    await this.repo.attachToMessage(ready.id, sent.message.id);
    return { message: sent.message, attachment: toAttachmentDto(ready) };
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /** A short-lived URL for an agent. Scoped by the conversation they are allowed to see. */
  async downloadUrlForAgent(context: TenantContext, attachmentId: string): Promise<string> {
    const attachment = await this.repo.findById(context.accountId, attachmentId);
    if (!attachment || attachment.status !== 'ready') throw new AppError(ErrorCode.NOT_FOUND);
    await this.options.conversations.get(context, attachment.conversationId);
    return this.signDownload(attachment);
  }

  /** The same, for the visitor - who may only read files from their own conversations. */
  async downloadUrlForVisitor(identity: VisitorIdentity, attachmentId: string): Promise<string> {
    const attachment = await this.repo.findById(identity.accountId, attachmentId);
    if (!attachment || attachment.status !== 'ready') throw new AppError(ErrorCode.NOT_FOUND);
    const conversation = await this.conversationRepo.findForVisitor(
      identity.accountId,
      identity.visitorId,
      attachment.conversationId,
    );
    if (!conversation) throw new AppError(ErrorCode.NOT_FOUND);
    return this.signDownload(attachment);
  }

  listForConversation(accountId: string, conversationId: string): Promise<Attachment[]> {
    return this.repo.listForConversation(accountId, conversationId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Confirming twice must not send the file twice.
   *
   * `clientMessageId` would deduplicate the message when a client supplies one, but it is optional
   * - and "the caller happened to pass an idempotency key" is not a guarantee. Once an attachment
   * has become a message it is done, and a second confirm is a mistake worth naming.
   */
  private assertNotAlreadySent(attachment: Attachment): void {
    if (attachment.messageId) {
      throw new AppError(ErrorCode.CONFLICT, 'That file has already been sent');
    }
  }

  private assertSize(byteSize: number): void {
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > this.options.maxBytes) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, 'That file is too large');
    }
  }

  private async sign(input: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    uploaderType: 'visitor' | 'agent';
    uploaderMemberId: string | null;
    uploaderVisitorId: string | null;
    fileName: string;
    byteSize: number;
  }): Promise<SignedUpload> {
    // Nothing new is signed while the switch is off. Files already uploaded stay readable, which
    // is the difference between a kill switch and data loss.
    await this.options.flags?.assertEnabled('uploads', input.accountId);

    // A provisional name, so the row is readable in the database while the upload is in flight.
    // It is replaced at verification with one whose extension matches the real bytes.
    const fileName = safeFileName(input.fileName, 'bin');

    const attachment = await this.repo.create({
      accountId: input.accountId,
      propertyId: input.propertyId,
      conversationId: input.conversationId,
      uploaderType: input.uploaderType,
      uploaderMemberId: input.uploaderMemberId,
      uploaderVisitorId: input.uploaderVisitorId,
      // Placeholder: the real key needs the row's id, which does not exist until this insert.
      storageKey: `pending/${input.accountId}/${Date.now()}-${Math.random().toString(36).slice(2)}`,
      bucket: this.options.storage.bucketName,
      fileName,
      byteSize: input.byteSize,
    });

    const key = attachmentKey({
      accountId: input.accountId,
      propertyId: input.propertyId,
      attachmentId: attachment.id,
    });
    await this.options.db.attachment.update({ where: { id: attachment.id }, data: { storageKey: key } });

    return {
      attachmentId: attachment.id,
      uploadUrl: this.options.storage.signUpload(key, 300),
      expiresInSeconds: 300,
    };
  }

  /**
   * Find out what was actually uploaded.
   *
   * Reads one byte past the limit on purpose: an object exactly at the limit is fine, and one that
   * comes back longer is over it - which is how a client that lied about the size in step 1 is
   * caught, since the store enforces nothing on our behalf.
   */
  private async verify(attachment: Attachment): Promise<Attachment> {
    if (attachment.status === 'ready') return attachment;
    if (attachment.status === 'rejected') {
      throw new AppError(ErrorCode.FILE_TYPE_NOT_ALLOWED, attachment.rejectionReason ?? undefined);
    }

    const stored = await this.options.storage.read(attachment.storageKey, this.options.maxBytes + 1);
    if (!stored) {
      await this.repo.markRejected(attachment.id, 'Nothing was uploaded');
      throw new AppError(ErrorCode.UPLOAD_FAILED, 'That upload did not arrive');
    }

    if (stored.byteSize > this.options.maxBytes) {
      await this.discard(attachment, 'The file is larger than the limit');
      throw new AppError(ErrorCode.FILE_TOO_LARGE, 'That file is too large');
    }

    const kind = identifyFile(stored.bytes, attachment.fileName);
    if (!kind) {
      await this.discard(attachment, 'That kind of file is not accepted');
      throw new AppError(ErrorCode.FILE_TYPE_NOT_ALLOWED, 'That kind of file is not accepted');
    }

    return this.repo.markReady(attachment.id, {
      contentType: kind.contentType,
      byteSize: stored.byteSize,
      checksum: stored.checksum,
      // The name now ends in what the file really is. Somebody who uploaded `photo.png` and sent
      // a text file gets `photo.png.txt` back, which is the honest description of it.
      fileName: downloadName(attachment.fileName, kind.extension),
      confirmedAt: this.clock.now(),
    });
  }

  /** Take the bytes back out of the bucket. A refused upload must not linger there. */
  private async discard(attachment: Attachment, reason: string): Promise<void> {
    await this.options.storage.delete(attachment.storageKey).catch(() => undefined);
    await this.repo.markRejected(attachment.id, reason);
  }

  private signDownload(attachment: Attachment): string {
    return this.options.storage.signDownload(attachment.storageKey, {
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      expiresInSeconds: 600,
    });
  }
}

