import type { Job } from 'bullmq';
import {
  AiJob,
  type AiExtractFilePayload,
  type AiFollowupPayload,
  type LifecycleService,
  type AiIndexDocumentPayload,
  type AiReindexPropertyPayload,
  type AiReplyPayload,
  type AiReplyService,
  type AiSettingsService,
  type AiSuggestPayload,
  type CrawlService,
  type KnowledgeFileService,
  type KnowledgeService,
  type QueueProducer,
} from '@smartchat/core';
import type { Logger } from '@smartchat/logger';

/**
 * The AI queue: replies and indexing.
 *
 * A reply job has one attempt (set where it is enqueued): the reply service already turns every
 * failure into a ticket offer and a `failed` turn, and a retry would answer a question the
 * visitor has moved past. Indexing jobs keep the default retries - an embedding server that is
 * still loading its model is exactly the transient failure backoff exists for.
 */

export interface AiDeps {
  replies: AiReplyService;
  knowledge: KnowledgeService;
  settings: AiSettingsService;
  crawler: CrawlService;
  files: KnowledgeFileService;
  lifecycle: LifecycleService;
  queue: QueueProducer;
}

/** A website is re-read this often unless the owner asks sooner. */
const RECRAWL_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function processAiJob(job: Job, logger: Logger, deps: AiDeps): Promise<void> {
  switch (job.name) {
    case AiJob.REPLY: {
      const payload = job.data as AiReplyPayload;
      const started = Date.now();
      const outcome = await deps.replies.reply(payload);
      logger.info(
        {
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          ...outcome,
          jobMs: Date.now() - started,
        },
        outcome.posted ? 'ai reply posted' : 'ai reply skipped',
      );
      return;
    }
    case AiJob.INDEX_DOCUMENT: {
      const payload = job.data as AiIndexDocumentPayload;
      const result = await deps.knowledge.indexDocument(payload.accountId, payload.documentId);
      logger.info({ documentId: payload.documentId, chunks: result.chunks }, 'knowledge document indexed');
      return;
    }
    case AiJob.REMOVE_DOCUMENT: {
      const payload = job.data as AiIndexDocumentPayload;
      await deps.knowledge.deleteDocument(payload.accountId, payload.documentId);
      return;
    }
    case AiJob.REINDEX_PROPERTY: {
      const payload = job.data as AiReindexPropertyPayload;
      const queued = await deps.settings.syncProperty(payload.accountId, payload.propertyId);
      logger.info({ propertyId: payload.propertyId, queued }, 'knowledge re-index queued');
      return;
    }
    case AiJob.CRAWL_PROPERTY: {
      const payload = job.data as AiReindexPropertyPayload;
      const started = Date.now();
      const outcome = await deps.crawler.crawlProperty(payload.accountId, payload.propertyId);
      logger.info({ propertyId: payload.propertyId, ...outcome, ms: Date.now() - started }, outcome.error ? 'website sync failed' : 'website synced');
      return;
    }
    case AiJob.EXTRACT_FILE: {
      const payload = job.data as AiExtractFilePayload;
      const started = Date.now();
      const result = await deps.files.extract(payload.accountId, payload.fileId);
      logger.info({ fileId: payload.fileId, chunks: result.chunks, ms: Date.now() - started }, 'knowledge file indexed');
      return;
    }
    case AiJob.FOLLOWUP: {
      const payload = job.data as AiFollowupPayload;
      const outcome = await deps.lifecycle.run(payload);
      logger.info({ conversationId: payload.conversationId, kind: payload.kind, ...outcome }, outcome.acted ? 'ai follow-up acted' : 'ai follow-up skipped');
      return;
    }
    case AiJob.SUGGEST: {
      const payload = job.data as AiSuggestPayload;
      const started = Date.now();
      const outcome = await deps.replies.suggest(payload);
      logger.info({ conversationId: payload.conversationId, ...outcome, jobMs: Date.now() - started }, 'ai suggestions drafted');
      return;
    }
    case AiJob.RECRAWL_DUE: {
      const due = await deps.crawler.dueForRecrawl(RECRAWL_AFTER_MS);
      for (const entry of due) {
        await deps.queue.enqueueOnce(AiJob.CRAWL_PROPERTY, entry, `crawl-${entry.propertyId}`);
      }
      logger.info({ queued: due.length }, 'weekly website re-sync queued');
      return;
    }
    default:
      throw new Error(`Unknown AI job: ${job.name}`);
  }
}
