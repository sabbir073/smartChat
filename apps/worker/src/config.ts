import {
  baseEnvSchema,
  databaseEnvSchema,
  loadConfigOrExit,
  mailEnvSchema,
  redisEnvSchema,
  storageEnvSchema,
  urlsEnvSchema,
} from '@smartchat/config';
import { z } from 'zod';

const workerEnvSchema = baseEnvSchema
  .merge(urlsEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(mailEnvSchema)
  // The retention job deletes attachment objects as well as their rows, so the worker needs the
  // object store. Without it the rows would go and the files would stay - a storage bill nobody
  // can explain and a pile of personal data nobody can find.
  .merge(storageEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('worker'),
      /** How many jobs one worker process runs at once, per queue. */
      WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
      /** Exposed for the container health check. */
      WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3005),
    }),
  );

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(): WorkerConfig {
  return loadConfigOrExit(workerEnvSchema);
}
