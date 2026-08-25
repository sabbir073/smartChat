import Redis, { type RedisOptions } from 'ioredis';

export type RedisClient = Redis;

export interface CreateRedisOptions {
  url: string;
  keyPrefix?: string;
  /** Blocking clients (BullMQ, subscribers) need this. Command clients must not use it. */
  enableReadyCheck?: boolean;
  /**
   * BullMQ requires this to be exactly `null` on any connection it uses for blocking commands.
   * `undefined` means "use our default"; `null` is a real, meaningful value that must survive.
   */
  maxRetriesPerRequest?: number | null;
  onError?: (error: Error) => void;
}

export const DEFAULT_MAX_RETRIES_PER_REQUEST = 3;

/**
 * Build the ioredis options for a connection.
 *
 * Extracted from `createRedisClient` purely so the `null` handling can be tested: `??` would
 * silently replace an explicit `null` with the default, and BullMQ refuses to start when that
 * happens. That is exactly the kind of bug that only shows up as a dead worker in production.
 */
export function buildRedisOptions(options: CreateRedisOptions): RedisOptions {
  const config: RedisOptions = {
    lazyConnect: false,
    enableReadyCheck: options.enableReadyCheck ?? true,
    maxRetriesPerRequest:
      options.maxRetriesPerRequest === undefined
        ? DEFAULT_MAX_RETRIES_PER_REQUEST
        : options.maxRetriesPerRequest,
    // Exponential-ish backoff with a ceiling: a Redis outage must not become a reconnect storm.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    reconnectOnError: (error) => error.message.includes('READONLY'),
  };
  if (options.keyPrefix) config.keyPrefix = options.keyPrefix;
  return config;
}

export function createRedisClient(options: CreateRedisOptions): RedisClient {
  const client = new Redis(options.url, buildRedisOptions(options));
  if (options.onError) client.on('error', options.onError);
  return client;
}
