import { createPrismaClient, type Database } from '@smartchat/database';
import {
  AccountService,
  AuthService,
  ConversationService,
  EntitlementService,
  LogMailProvider,
  LoginThrottle,
  PropertyService,
  QueueProducer,
  RateLimiter,
  PresenceService,
  RedisEventPublisher,
  SmtpMailProvider,
  TicketService,
  VisitorService,
  WidgetService,
  createRedisClient,
  systemClock,
  type Clock,
  type MailProvider,
  type RedisClient,
} from '@smartchat/core';
import type { Logger } from '@smartchat/logger';
import { DAY, MINUTE } from '@smartchat/core';
import type { ApiConfig } from './config.js';

export interface Container {
  config: ApiConfig;
  logger: Logger;
  db: Database;
  redis: RedisClient;
  clock: Clock;
  rateLimiter: RateLimiter;
  loginThrottle: LoginThrottle;
  queue: QueueProducer;
  mailer: MailProvider;
  auth: AuthService;
  accounts: AccountService;
  properties: PropertyService;
  widgets: WidgetService;
  visitors: VisitorService;
  conversations: ConversationService;
  presence: PresenceService;
  tickets: TicketService;
  entitlements: EntitlementService;
  shutdown(): Promise<void>;
}

/**
 * Composition root.
 *
 * Every dependency is constructed exactly once, here, and injected downward. Nothing below this
 * file reaches for a global connection, which is what makes the services testable against a real
 * database without a running HTTP server.
 */
export function createContainer(config: ApiConfig, logger: Logger): Container {
  const db = createPrismaClient({
    databaseUrl: config.DATABASE_URL,
    logQueries: config.LOG_LEVEL === 'trace',
    onQuery: (event) => logger.trace({ query: event.query, ms: event.duration }, 'db query'),
    onWarning: (message) => logger.warn({ message }, 'database warning'),
  });

  const redis = createRedisClient({
    url: config.REDIS_URL,
    onError: (error) => logger.error({ err: error }, 'redis error'),
  });

  // BullMQ requires a separate connection with blocking commands enabled; sharing the command
  // client would stall ordinary requests behind a blocking read.
  const queueRedis = createRedisClient({
    url: config.REDIS_URL,
    maxRetriesPerRequest: null,
    onError: (error) => logger.error({ err: error }, 'queue redis error'),
  });

  const clock = systemClock;
  const rateLimiter = new RateLimiter(redis, clock);
  const loginThrottle = new LoginThrottle(redis, clock);
  const queue = new QueueProducer(queueRedis);

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

  const entitlements = new EntitlementService(db);

  const auth = new AuthService({
    db,
    queue,
    mailer,
    throttle: loginThrottle,
    clock,
    brand: {
      productName: 'SmartChat',
      appUrl: config.APP_URL,
      supportEmail: config.MAIL_FROM_ADDRESS,
    },
    sessionTtlMs: config.SESSION_TTL_DAYS * DAY,
    passwordResetTtlMs: 60 * MINUTE,
    autoVerifyEmail: config.AUTO_VERIFY_EMAIL,
  });

  const accounts = new AccountService(db, entitlements);
  const widgets = new WidgetService(db, clock);
  const presence = new PresenceService(redis);
  const tickets = new TicketService(redis);

  const visitors = new VisitorService({
    db,
    visitorTokenSecret: config.VISITOR_TOKEN_SECRET,
    allowLocalhostOrigins: config.ALLOW_LOCALHOST_ORIGINS,
    isAgentAvailable: (accountId) => presence.hasAvailableAgent(accountId),
    clock,
  });

  /**
   * The API publishes domain events to the same Redis channel the gateway fans out from, rather
   * than calling the gateway directly. A message sent over HTTP therefore reaches connected
   * clients by exactly the same route as one sent over a socket.
   */
  const conversations = new ConversationService({
    db,
    events: new RedisEventPublisher(redis, (error) =>
      logger.error({ err: error }, 'failed to publish domain event'),
    ),
    clock,
  });
  const properties = new PropertyService({
    db,
    entitlements,
    widgetUrl: config.WIDGET_URL,
    clock,
  });

  return {
    config,
    logger,
    db,
    redis,
    clock,
    rateLimiter,
    loginThrottle,
    queue,
    mailer,
    auth,
    accounts,
    properties,
    widgets,
    visitors,
    conversations,
    presence,
    tickets,
    entitlements,
    async shutdown() {
      await queue.close().catch(() => {});
      await mailer.close?.().catch(() => {});
      await db.$disconnect().catch(() => {});
      redis.disconnect();
      queueRedis.disconnect();
    },
  };
}
