import type { Database, KnowledgeFile } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import { AiJob } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { knowledgeFileKey, safeFileName, downloadName } from '../storage/keys.js';
import { identifyFile } from '../storage/signature.js';
import type { StorageService } from '../storage/storage.service.js';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { systemClock, type Clock } from '../time.js';
import { extractFileText, readableFileType, UnreadableFileError } from './extract-file.js';
import type { KnowledgeService } from './knowledge.service.js';

/**
 * Files the owner uploads for the assistant to read.
 *
 * The upload is the attachment flow again, deliberately: the API signs a key it chose, the
 * browser PUTs the bytes to the store, and the API reads them back before it believes anything
 * about them. What is different is what happens next - the bytes go to the worker, which
 * extracts the text, makes a `file` knowledge document of it and indexes it, so a PDF price list
 * answers questions the same way a page of the website does.
 *
 * Limits are per website: ten megabytes a file, fifty files. Larger content belongs in the help
 * centre, where it can be edited.
 */

export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_KNOWLEDGE_FILES_PER_PROPERTY = 50;

export interface KnowledgeFileServiceOptions {
  db: Database;
  storage: StorageService;
  knowledge: KnowledgeService;
  queue: QueueProducer;
  clock?: Clock;
  maxBytes?: number;
  maxFiles?: number;
}

export interface KnowledgeFileView {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  status: KnowledgeFile['status'];
  error: string | null;
  /** Passages in the index, once ready. */
  chunks: number;
  createdAt: string;
}

export interface SignedFileUpload {
  fileId: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

export class KnowledgeFileService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly options: KnowledgeFileServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
    this.maxBytes = options.maxBytes ?? MAX_KNOWLEDGE_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_KNOWLEDGE_FILES_PER_PROPERTY;
  }

  async list(context: TenantContext, propertyId: string): Promise<KnowledgeFileView[]> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    return this.listFor(context.accountId, propertyId);
  }

  async listFor(accountId: string, propertyId: string): Promise<KnowledgeFileView[]> {
    const rows = await this.options.db.knowledgeFile.findMany({
      where: { accountId, propertyId },
      orderBy: { createdAt: 'desc' },
      include: { document: { select: { chunkCount: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      byteSize: row.byteSize,
      status: row.status,
      error: row.error,
      chunks: row.document?.chunkCount ?? 0,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Step one: a place to put the bytes. Nothing the client said is trusted yet. */
  async sign(
    context: TenantContext,
    propertyId: string,
    input: { fileName: string; byteSize: number },
  ): Promise<SignedFileUpload> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || input.byteSize > this.maxBytes) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, `Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    }
    const count = await this.options.db.knowledgeFile.count({
      where: { accountId: context.accountId, propertyId, status: { not: 'pending' } },
    });
    if (count >= this.maxFiles) {
      throw new AppError(ErrorCode.PLAN_LIMIT_REACHED, `A website can have up to ${this.maxFiles} files. Delete one first.`);
    }

    const fileName = safeFileName(input.fileName, 'bin');
    const file = await this.options.db.knowledgeFile.create({
      data: {
        accountId: context.accountId,
        propertyId,
        fileName,
        byteSize: input.byteSize,
        storageKey: `pending/${context.accountId}/${Date.now()}-${Math.random().toString(36).slice(2)}`,
        uploadedByMemberId: context.memberId ?? null,
      },
    });
    const key = knowledgeFileKey({ accountId: context.accountId, propertyId, fileId: file.id });
    await this.options.db.knowledgeFile.update({ where: { id: file.id }, data: { storageKey: key } });
    return { fileId: file.id, uploadUrl: this.options.storage.signUpload(key, 300), expiresInSeconds: 300 };
  }

  /**
   * Step three: the bytes are in the store; find out what they are. A file that is not one of
   * the readable kinds is deleted from the store and refused. A good one is handed to the worker.
   */
  async confirm(context: TenantContext, propertyId: string, fileId: string): Promise<KnowledgeFileView> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const file = await this.options.db.knowledgeFile.findFirst({
      where: { accountId: context.accountId, propertyId, id: fileId },
    });
    if (!file) throw new AppError(ErrorCode.NOT_FOUND);
    if (file.status !== 'pending') return this.viewOf(context.accountId, file.id);

    const stored = await this.options.storage.read(file.storageKey, this.maxBytes + 1);
    if (!stored) {
      await this.options.db.knowledgeFile.delete({ where: { id: file.id } });
      throw new AppError(ErrorCode.UPLOAD_FAILED, 'That upload did not arrive');
    }
    if (stored.byteSize > this.maxBytes) {
      await this.refuse(file);
      throw new AppError(ErrorCode.FILE_TOO_LARGE, 'That file is too large');
    }
    const kind = identifyFile(stored.bytes, file.fileName);
    const readable = kind ? readableFileType(kind.contentType === 'text/plain' && /\.(md|markdown)$/i.test(file.fileName) ? 'text/markdown' : kind.contentType) : null;
    if (!kind || !readable) {
      await this.refuse(file);
      throw new AppError(ErrorCode.FILE_TYPE_NOT_ALLOWED, 'Only PDF, Word (.docx), text and Markdown files can be read');
    }

    await this.options.db.knowledgeFile.update({
      where: { id: file.id },
      data: {
        status: 'processing',
        contentType: readable,
        byteSize: stored.byteSize,
        fileName: downloadName(file.fileName, kind.extension),
        confirmedAt: this.clock.now(),
        error: null,
      },
    });
    await this.options.queue.enqueue(AiJob.EXTRACT_FILE, { accountId: context.accountId, fileId: file.id });
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.file.uploaded',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { fileId: file.id, fileName: file.fileName, byteSize: stored.byteSize },
    });
    return this.viewOf(context.accountId, file.id);
  }

  async remove(context: TenantContext, propertyId: string, fileId: string): Promise<void> {
    requirePermission(context, Permission.AI_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const file = await this.options.db.knowledgeFile.findFirst({
      where: { accountId: context.accountId, propertyId, id: fileId },
    });
    if (!file) throw new AppError(ErrorCode.NOT_FOUND);
    if (file.documentId) await this.options.knowledge.deleteDocument(context.accountId, file.documentId);
    await this.options.storage.delete(file.storageKey).catch(() => undefined);
    await this.options.db.knowledgeFile.delete({ where: { id: file.id } });
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.file.deleted',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { fileId: file.id, fileName: file.fileName },
    });
  }

  /**
   * The worker's half: read the bytes, extract the text, make the document, index it. Runs once
   * per confirmed file; a failure is written on the row for the owner to read and the job is not
   * retried, because the same bytes will fail the same way.
   */
  async extract(accountId: string, fileId: string): Promise<{ chunks: number }> {
    const file = await this.options.db.knowledgeFile.findFirst({ where: { accountId, id: fileId } });
    if (!file || file.status === 'pending') return { chunks: 0 };
    const readable = readableFileType(file.contentType);
    if (!readable) {
      await this.fail(file.id, 'This kind of file cannot be read');
      return { chunks: 0 };
    }
    try {
      const stored = await this.options.storage.read(file.storageKey, this.maxBytes + 1);
      if (!stored) throw new UnreadableFileError('The file is no longer in storage');
      const text = await extractFileText(stored.bytes, readable);
      const document = await this.options.knowledge.syncFile(accountId, file.propertyId, {
        documentId: file.documentId,
        title: file.fileName,
        text,
      });
      await this.options.db.knowledgeFile.update({
        where: { id: file.id },
        data: { documentId: document.documentId, status: 'processing', error: null },
      });
      const result = await this.options.knowledge.indexDocument(accountId, document.documentId);
      await this.options.db.knowledgeFile.update({ where: { id: file.id }, data: { status: 'ready', error: null } });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(file.id, message.slice(0, 500));
      if (error instanceof UnreadableFileError) return { chunks: 0 };
      throw error;
    }
  }

  private async fail(fileId: string, error: string): Promise<void> {
    await this.options.db.knowledgeFile.updateMany({ where: { id: fileId }, data: { status: 'failed', error } });
  }

  /** A refused upload must not linger in the bucket, nor as a row the owner cannot act on. */
  private async refuse(file: KnowledgeFile): Promise<void> {
    await this.options.storage.delete(file.storageKey).catch(() => undefined);
    await this.options.db.knowledgeFile.delete({ where: { id: file.id } }).catch(() => undefined);
  }

  private async viewOf(accountId: string, fileId: string): Promise<KnowledgeFileView> {
    const rows = await this.options.db.knowledgeFile.findMany({
      where: { accountId, id: fileId },
      include: { document: { select: { chunkCount: true } } },
    });
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);
    return {
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      byteSize: row.byteSize,
      status: row.status,
      error: row.error,
      chunks: row.document?.chunkCount ?? 0,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
