import { createServer } from 'node:http';
import { Worker, type Job } from 'bullmq';
import {
  LogMailProvider,
  QueueName,
  QueueProducer,
  SmtpMailProvider,
  StorageService,
  createRedisClient,
  type MailProvider,
  type SendEmailPayload,
} from '@smartchat/core';
import { AnalyticsJob, MaintenanceJob, WebhookJob } from '@smartchat/core';
import { createPrismaClient } from '@smartchat/database';
import { createLogger, withLogContext } from '@smartchat/logger';
import { loadWorkerConfig } from './config.js';
import { processAnalyticsJob } from './processors/analytics.js';
import { processEmailJob } from './processors/email.js';
import { processWebhookJob } from './processors/webhook.js';
import { processMaintenanceJob } from './processors/maintenance.js';

const config = loadWorkerConfig();

const logger = createLogger({
  service: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

async function main(): Promise<void> {
  const db = createPrismaClient({
    databaseUrl: config.DATABASE_URL,
    onWarning: (message) => logger.warn({ message }, 'database warning'),
  });

  // BullMQ uses blocking reads, so it needs its own connection with retries disabled.
  const connection = createRedisClient({
    url: config.REDIS_URL,
    maxRetriesPerRequest: null,
    onError: (error) => logger.error({ err: error }, 'redis error'),
  });

  const mailer: MailProvider =
    config.MAIL_DRIVER === 'smtp' && config.SMTP_HOST
      ? new SmtpMailProvider({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT ?? 1025,
          secure: config.SMTP_SECURE,
          user: config.SMTP_USER,
          password: config.SMTP_PASSWORD,
          from: { email: config.MAIL_FROM_ADDRESS, name: config.MAIL_FROM_NAME },
        })
      : new LogMailProvider((message) =>
          logger.info({ to: message.to.email, subject: message.subject }, 'email (log driver)'),
        );

  /**
   * The object store, for the retention job.
   *
   * The worker reaches it by its name on the private network, the same as the API does. There is
   * no browser here, so the public endpoint is irrelevant and is set to the same value rather than
   * left to imply a second address that this process would never use.
   */
  const storage = new StorageService({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });

  const workers: Worker[] = [
    new Worker(
      QueueName.EMAIL,
      (job: Job<SendEmailPayload>) =>
        withLogContext({ jobId: job.id ?? undefined, requestId: job.data.requestId }, () =>
          processEmailJob(job, mailer, db, logger),
        ),
      { connection, concurrency: config.WORKER_CONCURRENCY },
    ),

    new Worker(
      QueueName.WEBHOOK,
      (job) =>
        withLogContext({ jobId: job.id ?? undefined }, () =>
          processWebhookJob(job, db, logger, {
            allowPrivateTargets: config.ALLOW_PRIVATE_WEBHOOK_URLS,
          }),
        ),
      // Several at once: these are outbound HTTP calls to other people's servers, and one slow
      // endpoint must not hold up everybody else's deliveries.
      { connection, concurrency: config.WORKER_CONCURRENCY },
    ),

    new Worker(
      QueueName.ANALYTICS,
      (job) =>
        withLogContext({ jobId: job.id ?? undefined }, () => processAnalyticsJob(job, db, logger)),
      // One at a time: the rollup walks every active account, and two overlapping runs would do
      // the same delete-and-rebuild twice for no benefit.
      { connection, concurrency: 1 },
    ),

    new Worker(
      QueueName.MAINTENANCE,
      (job: Job) =>
        withLogContext({ jobId: job.id ?? undefined }, () =>
          processMaintenanceJob(job, db, logger, storage),
        ),
      { connection, concurrency: 1 },
    ),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      const willRetry = (job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 1);
      logger.error(
        { jobId: job?.id, name: job?.name, attempt: job?.attemptsMade, willRetry, err: error },
        willRetry ? 'job failed - will retry' : 'job failed permanently',
      );
    });
    worker.on('error', (error) => logger.error({ err: error }, 'worker error'));
  }

  // Repeatable schedules use a stable job id, so restarting the worker cannot accumulate
  // duplicate schedules for the same task.
  const scheduler = new QueueProducer(connection);
  await scheduler.schedule(MaintenanceJob.PURGE_EXPIRED_SESSIONS, {}, '0 3 * * *');
  await scheduler.schedule(MaintenanceJob.PURGE_EXPIRED_TOKENS, {}, '30 3 * * *');
  await scheduler.schedule(MaintenanceJob.APPLY_RETENTION, {}, '0 4 * * *');
  // Every quarter of an hour. Frequent enough that a report opened after lunch reflects the
  // morning; cheap enough that it is two days of aggregate per account, not the whole history.
  await scheduler.schedule(AnalyticsJob.ROLLUP, {}, '*/15 * * * *');
  // The safety net under the webhook queue: every minute, ask the database what is due. See
  // processors/webhook.ts for why this exists and not merely for tidiness.
  await scheduler.schedule(WebhookJob.SWEEP, {}, '* * * * *');

  /**
   * A minimal health server.
   *
   * The worker has no HTTP surface of its own, but Docker needs something to probe — and "the
   * process is up" is a genuinely different question from "the queue is draining", so /ready
   * checks the dependencies the worker actually needs.
   */
  const health = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: config.SERVICE_NAME }));
      return;
    }
    if (request.url === '/ready') {
      Promise.allSettled([db.$queryRaw`SELECT 1`, connection.ping()])
        .then((results) => {
          const healthy = results.every((result) => result.status === 'fulfilled');
          response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: healthy ? 'ready' : 'degraded' }));
        })
        .catch(() => {
          response.writeHead(503).end();
        });
      return;
    }
    response.writeHead(404).end();
  });
  health.listen(config.WORKER_HEALTH_PORT);

  logger.info({ queues: workers.length, concurrency: config.WORKER_CONCURRENCY }, 'worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out - exiting');
      process.exit(1);
    }, 20_000);
    timeout.unref();

    health.close();
    // close() waits for in-flight jobs, so a deploy never abandons a half-processed job.
    await Promise.all(workers.map((worker) => worker.close()));
    await scheduler.close();
    await db.$disconnect();
    connection.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled rejection'),
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
