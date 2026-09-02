import type { MailMessage } from '../mail/provider.js';

/** Queue names. One queue per concern so a slow webhook endpoint cannot delay a password reset. */
export const QueueName = {
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  ANALYTICS: 'analytics',
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const EmailJob = {
  SEND: 'email.send',
  /**
   * A billing event that owes somebody an email.
   *
   * A separate job name rather than a pre-rendered message, because the worker is where mail
   * templates live and the API should not be composing copy it cannot see rendered.
   */
  SEND_BILLING: 'email.billing',
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
   * Roll subscriptions forward: end trials, start new periods, issue invoices, apply the grace
   * window. Idempotent, so it is safe to run hourly even though it usually finds nothing.
   */
  SUBSCRIPTION_LIFECYCLE: 'maintenance.subscription_lifecycle',
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
export interface BillingNotificationPayload {
  event: {
    type: string;
    accountId: string;
    [key: string]: unknown;
  };
}

export type JobPayloadMap = {
  [EmailJob.SEND]: SendEmailPayload;
  [EmailJob.SEND_BILLING]: BillingNotificationPayload;
  [AnalyticsJob.ROLLUP]: AnalyticsRollupPayload;
  [WebhookJob.DELIVER]: { deliveryId: string };
  [WebhookJob.SWEEP]: Record<string, never>;
  [MaintenanceJob.PURGE_EXPIRED_SESSIONS]: Record<string, never>;
  [MaintenanceJob.PURGE_EXPIRED_TOKENS]: Record<string, never>;
  [MaintenanceJob.APPLY_RETENTION]: Record<string, never>;
  [MaintenanceJob.SUBSCRIPTION_LIFECYCLE]: Record<string, never>;
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
