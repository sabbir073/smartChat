import type { MailMessage } from '../mail/provider.js';

/** Queue names. One queue per concern so a slow webhook endpoint cannot delay a password reset. */
export const QueueName = {
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  ANALYTICS: 'analytics',
  MAINTENANCE: 'maintenance',
  /** AI replies and knowledge indexing. Its own queue: a slow model must not delay an email. */
  AI: 'ai',
  /**
   * Call timers and the AI's call sessions. Its own queue because a ring timeout is a deadline
   * measured in seconds, and the AI queue holds crawls that take minutes.
   */
  VOICE: 'voice',
  /** The AI's call sessions, consumed by the voice agent process and by nothing else. */
  VOICE_AI: 'voice_ai',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const EmailJob = {
  SEND: 'email.send',
} as const;

export const AnalyticsJob = {
  ROLLUP: 'analytics.rollup',
} as const;

export const WebhookJob = {
  DELIVER: 'webhook.deliver',
  SWEEP: 'webhook.sweep',
} as const;

export const MaintenanceJob = {
  PURGE_EXPIRED_SESSIONS: 'maintenance.purge_expired_sessions',
  PURGE_EXPIRED_TOKENS: 'maintenance.purge_expired_tokens',
  APPLY_RETENTION: 'maintenance.apply_retention',
  /**
   * Rebuild the IP → country table from the five registries' daily files. Idempotent and
   * all-or-nothing: a partial fetch leaves yesterday's data in place rather than a continent
   * missing. Daily, and once at startup when the table has never been loaded.
   */
  REFRESH_GEO: 'maintenance.refresh_geo',
  /**
   * Notice accounts whose grace window has closed: stamp them locked and tell the owner, once.
   * Hourly. The lock itself applies at the moment the window closes, with or without this.
   */
  BILLING_RECONCILE: 'maintenance.billing_reconcile',
  /** Close the widget's own greetings that nobody answered. Every ten minutes. */
  EXPIRE_GREETINGS: 'maintenance.expire_greetings',
} as const;

export const AiJob = {
  /**
   * Answer one visitor message. Enqueued by the realtime server once the message is stored and
   * the dispatch rules say the AI should speak; the worker re-checks those rules before it does,
   * because a person may have taken over in the meantime.
   */
  REPLY: 'ai.reply',
  /** (Re)index one knowledge document: chunk, embed, replace. */
  INDEX_DOCUMENT: 'ai.index_document',
  /** Remove one document and its chunks from the index. */
  REMOVE_DOCUMENT: 'ai.remove_document',
  /** Rebuild every document of one property - after the notes change, or on "re-index". */
  REINDEX_PROPERTY: 'ai.reindex_property',
  /** Crawl one property's website and index it. Minutes long; one at a time per property. */
  CRAWL_PROPERTY: 'ai.crawl_property',
  EXTRACT_FILE: 'ai.extract_file',
  /** Read one page the owner pasted the address of, and index it. */
  READ_LINK: 'ai.read_link',
  /** A delayed follow-up in one conversation: take back after a handoff, nudge, close. */
  FOLLOWUP: 'ai.followup',
  /** Reply suggestions for the person handling a chat. */
  SUGGEST: 'ai.suggest',
  /** Daily: queue a crawl for every AI-enabled website not read in the last week. */
  RECRAWL_DUE: 'ai.recrawl_due',
} as const;

export interface AiReplyPayload {
  accountId: string;
  propertyId: string;
  conversationId: string;
  /** The visitor message being answered. The reply is idempotent on it. */
  messageId: string;
  requestId?: string;
}

export interface AiIndexDocumentPayload {
  accountId: string;
  documentId: string;
}

export interface AiReindexPropertyPayload {
  accountId: string;
  propertyId: string;
}

export interface AiExtractFilePayload {
  accountId: string;
  fileId: string;
}

/** One page the owner pasted: the document was created before the job, so it has an id already. */
export interface AiReadLinkPayload {
  accountId: string;
  propertyId: string;
  documentId: string;
}

export type AiFollowupKind = 'handoff_wait' | 'idle_nudge' | 'idle_close';

export interface AiFollowupPayload {
  accountId: string;
  conversationId: string;
  kind: AiFollowupKind;
  /** The conversation's `aiFollowupSeq` when this was scheduled; a different value means stale. */
  seq: number;
}

export interface AiSuggestPayload {
  accountId: string;
  conversationId: string;
  /** The visitor message the suggestions answer. */
  messageId: string;
}

export const VoiceJob = {
  /** The team was rung this long and nobody answered: the AI picks up, or the call is missed. */
  RING_TIMEOUT: 'voice.ring_timeout',
  /** The one person a call was transferred to did not answer in time. */
  TRANSFER_TIMEOUT: 'voice.transfer_timeout',
  /** The AI should join a call's room and talk. Consumed by the voice agent, not the worker. */
  AI_JOIN: 'voice.ai_join',
  /** Every minute: end calls whose parties vanished without a word (a closed laptop, a crash). */
  SWEEP: 'voice.sweep',
} as const;

export interface VoiceRingTimeoutPayload {
  accountId: string;
  callId: string;
  /** The call's `ringSeq` when the timer was set; a different value means the call moved on. */
  ringSeq: number;
}

export interface VoiceAiJoinPayload {
  accountId: string;
  callId: string;
  /** The AI leg that was created for this join, so a stale job does not start a second session. */
  legId: string;
}

export interface SendEmailPayload {
  message: MailMessage;
  /** Correlates the job back to the request that created it. */
  requestId?: string;
  accountId?: string;
  /**
   * The `email_deliveries` row this job is the attempt for.
   *
   * Present for anything worth answering "did it actually go?" about - ticket mail, notifications.
   * Absent for platform mail such as a password reset, where the row would carry a token-bearing
   * subject line into a table people browse.
   */
  deliveryId?: string;
}

export interface AnalyticsRollupPayload {
  /**
   * How far back to recompute, in the account's own days.
   *
   * Two by default: today, because it is still happening, and yesterday, because a conversation
   * that started at 23:58 and was answered at 00:03 changes yesterday's numbers after yesterday
   * has ended. Anything older only changes when somebody edits history, which is what the manual
   * rebuild is for.
   */
  days?: number;
}

/**
 * What a billing notification carries.
 *
 * The event, not a rendered message. Keeping the payload this small means a queued job that runs
 * after a deploy renders with the *current* template rather than one that was current when it was
 * enqueued - and an email whose wording changed while it sat in a queue is a small mystery nobody
 * needs.
 */
export type JobPayloadMap = {
  [EmailJob.SEND]: SendEmailPayload;
  [AnalyticsJob.ROLLUP]: AnalyticsRollupPayload;
  [WebhookJob.DELIVER]: { deliveryId: string };
  [WebhookJob.SWEEP]: Record<string, never>;
  [MaintenanceJob.PURGE_EXPIRED_SESSIONS]: Record<string, never>;
  [MaintenanceJob.PURGE_EXPIRED_TOKENS]: Record<string, never>;
  [MaintenanceJob.APPLY_RETENTION]: Record<string, never>;
  [MaintenanceJob.REFRESH_GEO]: Record<string, never>;
  [MaintenanceJob.BILLING_RECONCILE]: Record<string, never>;
  [MaintenanceJob.EXPIRE_GREETINGS]: Record<string, never>;
  [AiJob.REPLY]: AiReplyPayload;
  [AiJob.INDEX_DOCUMENT]: AiIndexDocumentPayload;
  [AiJob.REMOVE_DOCUMENT]: AiIndexDocumentPayload;
  [AiJob.REINDEX_PROPERTY]: AiReindexPropertyPayload;
  [AiJob.CRAWL_PROPERTY]: AiReindexPropertyPayload;
  [AiJob.EXTRACT_FILE]: AiExtractFilePayload;
  [AiJob.READ_LINK]: AiReadLinkPayload;
  [AiJob.FOLLOWUP]: AiFollowupPayload;
  [AiJob.SUGGEST]: AiSuggestPayload;
  [AiJob.RECRAWL_DUE]: Record<string, never>;
  [VoiceJob.RING_TIMEOUT]: VoiceRingTimeoutPayload;
  [VoiceJob.TRANSFER_TIMEOUT]: VoiceRingTimeoutPayload;
  [VoiceJob.AI_JOIN]: VoiceAiJoinPayload;
  [VoiceJob.SWEEP]: Record<string, never>;
};

export type JobName = keyof JobPayloadMap;

/**
 * Default retry policy.
 *
 * Exponential backoff from 5 s means a provider blip is absorbed silently, while a genuinely dead
 * endpoint stops being retried within about ten minutes instead of hammering it forever.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
