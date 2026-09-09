import type { Job } from 'bullmq';
import {
  AiJob,
  type AiIndexDocumentPayload,
  type AiReindexPropertyPayload,
  type AiReplyPayload,
  type AiReplyService,
  type AiSettingsService,
  type KnowledgeService,
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
}

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
    default:
      throw new Error(`Unknown AI job: ${job.name}`);
  }
}
