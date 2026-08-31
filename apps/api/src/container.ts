import { createPrismaClient, type Database } from '@smartchat/database';
import {
  AccountService,
  AnalyticsService,
  ApiKeyService,
  FeatureFlagService,
  PlatformService,
  RetentionService,
  WebhookService,
  AttachmentService,
  AuthService,
  AutomationService,
  ContactService,
  KbService,
  ConversationService,
  EmailJob,
  WebhookJob,
  EntitlementService,
  LogMailProvider,
  LoginThrottle,
  PropertyService,
  QueueProducer,
  RateLimiter,
  PresenceService,
  RedisEventPublisher,
  SmtpMailProvider,
  StorageService,
  TeamService,
  TicketService,
  ConnectionTicketService,
  VisitorService,
  WidgetService,
  createRedisClient,
  systemClock,
  type Clock,
  type MailDeliver,
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
  team: TeamService;
  automation: AutomationService;
  contacts: ContactService;
  kb: KbService;
  tickets: TicketService;
  analytics: AnalyticsService;
  apiKeys: ApiKeyService;
  platform: PlatformService;
  retention: RetentionService;
  flags: FeatureFlagService;
  webhooks: WebhookService;
  storage: StorageService;
  attachments: AttachmentService;
  properties: PropertyService;
  widgets: WidgetService;
  visitors: VisitorService;
  conversations: ConversationService;
  presence: PresenceService;
  connectionTickets: ConnectionTicketService;
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

  const brand = {
    productName: 'SmartChat',
    appUrl: config.APP_URL,
    supportEmail: config.MAIL_FROM_ADDRESS,
  };

  const auth = new AuthService({
    db,
    queue,
    mailer,
    throttle: loginThrottle,
    clock,
    brand,
    sessionTtlMs: config.SESSION_TTL_DAYS * DAY,
    passwordResetTtlMs: 60 * MINUTE,
    autoVerifyEmail: config.AUTO_VERIFY_EMAIL,
  });

  const accounts = new AccountService(db, entitlements);

  const team = new TeamService({
    db,
    mailer,
    brand,
    // Same reasoning as the auth service: a slow SMTP server must never hold up an HTTP response.
    deliver: queue
      ? (message) =>
          queue.enqueue(EmailJob.SEND, { message, requestId: 'team' }).then(() => undefined)
      : undefined,
    clock,
  });
  const widgets = new WidgetService(db, clock);
  const presence = new PresenceService(redis);
  const connectionTickets = new ConnectionTicketService(redis);

  const visitors = new VisitorService({
    db,
    visitorTokenSecret: config.VISITOR_TOKEN_SECRET,
    allowLocalhostOrigins: config.ALLOW_LOCALHOST_ORIGINS,
    isAgentAvailable: (accountId) => presence.hasAvailableAgent(accountId),
    maxUploadBytes: config.UPLOAD_MAX_BYTES,
    clock,
  });

  /**
   * The platform kill switches, read on ordinary requests.
   *
   * Constructed before anything that consults them, and deliberately fail-open: a flag row that
   * does not exist, or a database that will not answer, means the capability is on. A hiccup must
   * not silently turn off uploads for every customer.
   */
  const flags = new FeatureFlagService(db);

  const automation = new AutomationService({ db, clock });
  const contacts = new ContactService({ db, clock });
  const kb = new KbService({ db, flags, clock });
  const analytics = new AnalyticsService({ db, clock });
  const apiKeys = new ApiKeyService({ db, clock });
  const platform = new PlatformService({ db, clock });

  /**
   * Webhooks.
   *
   * The delivery row is written by the request that caused the event; `notify` is only a nudge so
   * the dispatcher does not wait for its next sweep. A queue that is down therefore costs latency,
   * not the delivery - which is the entire reason the row is written first.
   */
  const webhooks = new WebhookService({
    db,
    clock,
    flags,
    allowPrivateTargets: config.ALLOW_PRIVATE_WEBHOOK_URLS,
    notify: (deliveryId) => queue.enqueue(WebhookJob.DELIVER, { deliveryId }).then(() => undefined),
  });

  /**
   * How a ticket email actually leaves the building.
   *
   * The delivery row is written first and the job carries its id, so the sequence is: a row that
   * says `queued`, then a worker that turns it into `sent` or `failed`. A row that stays `queued`
   * is therefore a real signal - the queue is down, or the worker is not running - rather than a
   * silence indistinguishable from a quiet day.
   */
  const deliverTicketMail: MailDeliver = async ({
    message,
    template,
    accountId,
    ticketId,
    ticketMessageId,
  }) => {
    const delivery = await db.emailDelivery.create({
      data: {
        accountId,
        template,
        toEmail: message.to.email,
        subject: message.subject,
        ticketId: ticketId ?? null,
        ticketMessageId: ticketMessageId ?? null,
      },
      select: { id: true },
    });
    await queue.enqueue(EmailJob.SEND, {
      message,
      requestId: template,
      accountId,
      deliveryId: delivery.id,
    });
  };

  const tickets = new TicketService({ db, brand, deliver: deliverTicketMail, webhooks, clock });

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
    // An offline message is a request nobody was there to answer, so it becomes a ticket.
    tickets,
    webhooks,
    clock,
  });

  /**
   * Object storage.
   *
   * Two endpoints, and they are genuinely different machines as far as anybody is concerned: this
   * service reaches the store by its name on the private network, and a browser reaches it by a
   * name that resolves on the public internet. A signed URL has to be built against whichever one
   * the caller will actually use, or its host will not match its signature.
   */
  const storage = new StorageService({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    clock,
  });

  const retention = new RetentionService({ db, storage, clock });

  const attachments = new AttachmentService({
    db,
    storage,
    conversations,
    maxBytes: config.UPLOAD_MAX_BYTES,
    flags,
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
    team,
    automation,
    contacts,
    kb,
    tickets,
    analytics,
    apiKeys,
    platform,
    flags,
    retention,
    webhooks,
    storage,
    attachments,
    properties,
    widgets,
    visitors,
    conversations,
    presence,
    connectionTickets,
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
