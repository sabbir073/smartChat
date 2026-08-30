import { Queue, type JobsOptions } from 'bullmq';
import type { RedisClient } from '../redis/client.js';
import { DEFAULT_JOB_OPTIONS, QueueName, type JobName, type JobPayloadMap } from './jobs.js';

const QUEUE_FOR_JOB: Record<string, QueueName> = {
  'email.send': QueueName.EMAIL,
  'analytics.rollup': QueueName.ANALYTICS,
  'webhook.deliver': QueueName.WEBHOOK,
  'webhook.sweep': QueueName.WEBHOOK,
  'maintenance.purge_expired_sessions': QueueName.MAINTENANCE,
  'maintenance.purge_expired_tokens': QueueName.MAINTENANCE,
  'maintenance.apply_retention': QueueName.MAINTENANCE,
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

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
