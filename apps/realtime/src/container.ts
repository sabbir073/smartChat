import {
  ConversationService,
  PresenceService,
  RedisEventPublisher,
  TicketService,
  createRedisClient,
  systemClock,
  type Clock,
  type RedisClient,
} from '@smartchat/core';
import { createPrismaClient, type Database } from '@smartchat/database';
import type { Logger } from '@smartchat/logger';
import type { RealtimeConfig } from './config.js';

export interface RealtimeContainer {
  config: RealtimeConfig;
  logger: Logger;
  db: Database;
  clock: Clock;
  /** Command client: presence, tickets, publishing. */
  redis: RedisClient;
  /** Socket.IO's adapter needs its own pub and sub connections. */
  pubClient: RedisClient;
  subClient: RedisClient;
  /** A fourth connection, because a subscribed client cannot run ordinary commands. */
  eventSubscriber: RedisClient;
  presence: PresenceService;
  tickets: TicketService;
  conversations: ConversationService;
  shutdown(): Promise<void>;
}

/**
 * Composition root for the gateway.
 *
 * Four Redis connections looks like a lot until you remember that a subscribed Redis client cannot
 * issue any other command: the adapter needs a dedicated pair, our own event subscriber needs its
 * own, and everything else needs a normal command client.
 */
export function createRealtimeContainer(config: RealtimeConfig, logger: Logger): RealtimeContainer {
  const db = createPrismaClient({
    databaseUrl: config.DATABASE_URL,
    onWarning: (message) => logger.warn({ message }, 'database warning'),
  });

  const make = (name: string) =>
    createRedisClient({
      url: config.REDIS_URL,
      onError: (error) => logger.error({ err: error, connection: name }, 'redis error'),
    });

  const redis = make('command');
  const pubClient = make('adapter-pub');
  const subClient = make('adapter-sub');
  const eventSubscriber = make('event-sub');

  const clock = systemClock;
  const presence = new PresenceService(redis);
  const tickets = new TicketService(redis);

  const conversations = new ConversationService({
    db,
    events: new RedisEventPublisher(redis, (error) =>
      logger.error({ err: error }, 'failed to publish domain event'),
    ),
    clock,
  });

  return {
    config,
    logger,
    db,
    clock,
    redis,
    pubClient,
    subClient,
    eventSubscriber,
    presence,
    tickets,
    conversations,
    async shutdown() {
      await db.$disconnect().catch(() => undefined);
      for (const client of [redis, pubClient, subClient, eventSubscriber]) {
        client.disconnect();
      }
    },
  };
}
