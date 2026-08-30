import type { MailMessage } from '../mail/provider.js';

/** Queue names. One queue per concern so a slow webhook endpoint cannot delay a password reset. */
export const QueueName = {
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  ANALYTICS: 'analytics',
  MAINTENANCE: 'maintenance',
  TRIGGER: 'trigger',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const EmailJob = {
  SEND: 'email.send',
} as const;

export const MaintenanceJob = {
  PURGE_EXPIRED_SESSIONS: 'maintenance.purge_expired_sessions',
  PURGE_EXPIRED_TOKENS: 'maintenance.purge_expired_tokens',
  APPLY_RETENTION: 'maintenance.apply_retention',
} as const;

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

export type JobPayloadMap = {
  [EmailJob.SEND]: SendEmailPayload;
  [MaintenanceJob.PURGE_EXPIRED_SESSIONS]: Record<string, never>;
  [MaintenanceJob.PURGE_EXPIRED_TOKENS]: Record<string, never>;
  [MaintenanceJob.APPLY_RETENTION]: Record<string, never>;
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
