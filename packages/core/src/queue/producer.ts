import { Queue, type JobsOptions } from 'bullmq';
import type { RedisClient } from '../redis/client.js';
import { DEFAULT_JOB_OPTIONS, QueueName, type JobName, type JobPayloadMap } from './jobs.js';

/**
 * Which queue each job belongs to.
 *
 * Typed as `Record<JobName, QueueName>` and not `Record<string, ...>`, so adding a job name
 * without adding it here does not compile. It used to be string-keyed, and the consequence was
 * not a missing job - it was the **whole worker process refusing to start**, at boot, because
 * scheduling an unregistered job throws. Two new billing jobs shipped, the worker died on start,
 * and every email in the product silently stopped: invitations, ticket notifications, password
 * resets. A map the compiler cannot check is a map somebody will one day not finish.
 */
const QUEUE_FOR_JOB: Record<JobName, QueueName> = {
  'email.send': QueueName.EMAIL,
  'analytics.rollup': QueueName.ANALYTICS,
  'webhook.deliver': QueueName.WEBHOOK,
  'webhook.sweep': QueueName.WEBHOOK,
  'maintenance.purge_expired_sessions': QueueName.MAINTENANCE,
  'maintenance.purge_expired_tokens': QueueName.MAINTENANCE,
  'maintenance.apply_retention': QueueName.MAINTENANCE,
  'maintenance.refresh_geo': QueueName.MAINTENANCE,
  'maintenance.billing_reconcile': QueueName.MAINTENANCE,
  'ai.reply': QueueName.AI,
  'ai.index_document': QueueName.AI,
  'ai.remove_document': QueueName.AI,
  'ai.reindex_property': QueueName.AI,
  'ai.crawl_property': QueueName.AI,
  'ai.extract_file': QueueName.AI,
  'ai.followup': QueueName.AI,
  'ai.suggest': QueueName.AI,
  'ai.recrawl_due': QueueName.AI,
};

/**
 * Typed job producer.
 *
 * The payload type is derived from the job name, so a queue and its consumer cannot drift apart
 * without the compiler noticing.
 */
export class QueueProducer {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: RedisClient) {}

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<T extends JobName>(
    job: T,
    payload: JobPayloadMap[T],
    options?: JobsOptions,
  ): Promise<void> {
    const queueName = QUEUE_FOR_JOB[job];
    if (!queueName) throw new Error(`No queue registered for job "${job}"`);
    await this.queue(queueName).add(job, payload, options);
  }

  /**
   * A repeatable job with a stable `jobId`, so restarting the API does not accumulate duplicate
   * schedules for the same maintenance task.
   */
  async schedule<T extends JobName>(
    job: T,
    payload: JobPayloadMap[T],
    pattern: string,
  ): Promise<void> {
    const queueName = QUEUE_FOR_JOB[job];
    if (!queueName) throw new Error(`No queue registered for job "${job}"`);
    await this.queue(queueName).add(job, payload, {
      repeat: { pattern },
      jobId: `repeat:${job}`,
    });
  }

  /**
   * Run once, now, and only if the same request is not already queued or running.
   *
   * `jobId` is BullMQ's de-duplication key: a second call with the same id while the first is
   * still in the queue is a no-op. Used for "load this the first time" work that must not stack
   * up when several replicas start together.
   */
  async enqueueOnce<T extends JobName>(
    job: T,
    payload: JobPayloadMap[T],
    dedupeKey: string,
  ): Promise<void> {
    const queueName = QUEUE_FOR_JOB[job];
    if (!queueName) throw new Error(`No queue registered for job "${job}"`);
    const queue = this.queue(queueName);
    const jobId = onceJobId(dedupeKey);

    /**
     * "Once" means one *pending* copy, not one ever. BullMQ keeps a finished job under its id
     * for as long as `removeOnComplete`/`removeOnFail` say - a day here - and silently drops a
     * new add that reuses the id while it is there. The first version relied on that, and the
     * geo table stayed empty for hours: the first load had run and given up, and every later
     * "table is empty, queue the load" at worker start was a no-op against its corpse. A job
     * that has finished is cleared out of the way; one that is waiting or running is left, and
     * that is the de-duplication that was wanted.
     */
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
    }
    await queue.add(job, payload, { jobId });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

/**
 * BullMQ refuses a custom job id containing `:`, which is its own key separator - the first
 * version of this used `once:<key>` and took the worker down in a crash loop at startup. The
 * repeatable jobs above get away with `repeat:` only because BullMQ derives their real id itself.
 * Exported so the rule can be tested without a Redis.
 */
export function onceJobId(dedupeKey: string): string {
  const safe = dedupeKey.replace(/[^A-Za-z0-9_-]/g, '-');
  return `once-${safe}`;
}
