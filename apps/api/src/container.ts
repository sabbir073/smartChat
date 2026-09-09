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
  BillingService,
  EntitlementService,
  PlatformBillingService,
  PlatformSettingsService,
  StripeGateway,
  StripeWebhookService,
  ContactService,
  KbService,
  ConversationService,
  EmailJob,
  WebhookJob,
  LogMailProvider,
  LoginThrottle,
  PropertyService,
  QueueProducer,
  RateLimiter,
  PresenceService,
  RedisEventPublisher,
  GeoService,
  RedisAvailabilityPublisher,
  createOutboundFetch,
  findAccountOwner,
  SmtpMailProvider,
  agentAvailabilityReader,
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
  AccountAiService,
  AiAnalyticsService,
  AiFeedbackService,
  AiReplyService,
  AiSettingsService,
  KnowledgeFileService,
  KnowledgeService,
  PlatformAiService,
  createAiGateway,
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
  geo: GeoService;
  settings: PlatformSettingsService;
  entitlements: EntitlementService;
  billing: BillingService;
  platformBilling: PlatformBillingService;
  /** The AI agent: per-website settings and the knowledge index. */
  aiSettings: AiSettingsService;
  /** Files the owner uploads for the assistant to read. */
  aiFiles: KnowledgeFileService;
  /** The visitor's thumbs up or down on an AI reply. */
  aiFeedback: AiFeedbackService;
  /** The AI report. */
  aiAnalytics: AiAnalyticsService;
  /** Drafts for agents. The visitor-facing replies run in the worker; this is the same engine, asked directly. */
  aiReplies: AiReplyService;
  /** The account's own hosted-model key. */
  accountAi: AccountAiService;
  platformAi: PlatformAiService;
  /** The Stripe client for the currently stored secret, or null when none is stored. */
  stripeGateway: () => Promise<StripeGateway | null>;
  /** Built per request from the current gateway; null when Stripe is not configured. */
  stripeWebhooks: () => Promise<{ service: StripeWebhookService; webhookSecret: string } | null>;
  conversations: ConversationService;
  presence: PresenceService;
  connectionTickets: ConnectionTicketService;
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
    poolMax: config.DATABASE_POOL_MAX,
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
          rejectUnauthorized: config.SMTP_TLS_REJECT_UNAUTHORIZED,
          servername: config.SMTP_TLS_SERVERNAME,
          from: { email: config.MAIL_FROM_ADDRESS, name: config.MAIL_FROM_NAME },
        })
      : new LogMailProvider((message) =>
          logger.info({ to: message.to.email, subject: message.subject }, 'email (log driver)'),
        );

  const brand = {
    productName: config.PRODUCT_NAME,
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

  const accounts = new AccountService(db);

  /**
   * Billing.
   *
   * The Stripe keys live in the database, entered through the console, so the gateway is built
   * from whatever is stored at the time of asking and rebuilt when that changes. Entitlements are
   * the one reader of the plan table; every limit and feature gate below goes through them.
   */
  const settings = new PlatformSettingsService(db, config.SETTINGS_ENCRYPTION_KEY);
  const entitlements = new EntitlementService({
    db,
    graceDays: () => settings.graceDays(),
    clock,
  });
  let gatewayCache: { secretKey: string; gateway: StripeGateway } | null = null;
  const stripeGateway = async (): Promise<StripeGateway | null> => {
    const stripe = await settings.stripe();
    if (!stripe) {
      gatewayCache = null;
      return null;
    }
    let entry = gatewayCache;
    if (entry === null || entry.secretKey !== stripe.secretKey) {
      entry = {
        secretKey: stripe.secretKey,
        gateway: new StripeGateway(stripe.secretKey, { productName: config.PRODUCT_NAME }),
      };
      gatewayCache = entry;
    }
    return entry.gateway;
  };
  const deliverBillingMail = (message: Parameters<MailProvider['send']>[0]): Promise<void> =>
    queue.enqueue(EmailJob.SEND, { message, requestId: 'billing' }).then(() => undefined);
  /** The person billing emails go to: the account's owner. */
  const ownerOf = (accountId: string) => findAccountOwner(db, accountId);

  /**
   * Whether anybody on this account is available, and how a change in that reaches open widgets.
   *
   * The read is the persisted choice on the membership rows - see `agentAvailabilityReader` for
   * why it is not Redis presence. The announcement goes over Redis because the sockets that need
   * to hear it live in the realtime gateway, a different process from this one.
   */
  const hasAvailableAgent = agentAvailabilityReader(db);
  const availabilityPublisher = new RedisAvailabilityPublisher(queueRedis, (error) =>
    logger.error({ err: error }, 'could not announce availability'),
  );
  const announceAvailability = async (accountId: string): Promise<void> => {
    const available = await hasAvailableAgent(accountId);
    await availabilityPublisher.publishAvailability({ accountId, available });
  };

  const team = new TeamService({
    db,
    mailer,
    brand,
    // Same reasoning as the auth service: a slow SMTP server must never hold up an HTTP response.
    deliver: queue
      ? (message) =>
          queue.enqueue(EmailJob.SEND, { message, requestId: 'team' }).then(() => undefined)
      : undefined,
    announceAvailability,
    assertCanInviteMember: (accountId) => entitlements.assertCanInviteMember(accountId),
    clock,
  });
  const widgets = new WidgetService(db, clock);
  const presence = new PresenceService(redis);
  const connectionTickets = new ConnectionTicketService(redis);

  // Lookup only. The table is rebuilt by the worker; this process never fetches a registry.
  const geo = new GeoService({ db, clock });

  const visitors = new VisitorService({
    db,
    visitorTokenSecret: config.VISITOR_TOKEN_SECRET,
    allowLocalhostOrigins: config.ALLOW_LOCALHOST_ORIGINS,
    isAgentAvailable: hasAvailableAgent,
    resolveCountry: (ip) => geo.lookup(ip).then((hit) => hit?.country ?? null),
    canRemoveBranding: (accountId) => entitlements.hasFeature(accountId, 'removeBranding'),
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
  const apiKeys = new ApiKeyService({
    db,
    assertIntegrationsAllowed: (accountId) => entitlements.assertFeature(accountId, 'integrations'),
    clock,
  });
  const platform = new PlatformService({ db, clock });

  /**
   * Webhooks.
   *
   * The delivery row is written by the request that caused the event; `notify` is only a nudge so
   * the dispatcher does not wait for its next sweep. A queue that is down therefore costs latency,
   * not the delivery - which is the entire reason the row is written first.
   */
  const webhooks = new WebhookService({
    assertIntegrationsAllowed: (accountId) => entitlements.assertFeature(accountId, 'integrations'),
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

  const tickets = new TicketService({
    db,
    brand,
    deliver: deliverTicketMail,
    webhooks,
    clock,
  });

  /**
   * The API publishes domain events to the same Redis channel the gateway fans out from, rather
   * than calling the gateway directly. A message sent over HTTP therefore reaches connected
   * clients by exactly the same route as one sent over a socket.
   */
  const events = new RedisEventPublisher(redis, (error) =>
    logger.error({ err: error }, 'failed to publish domain event'),
  );
  const conversations = new ConversationService({
    db,
    events,
    // An offline message is a request nobody was there to answer, so it becomes a ticket.
    tickets,
    webhooks,
    assertWritable: (accountId) => entitlements.assertNotLocked(accountId),
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
    widgetUrl: config.WIDGET_URL,
    assertCanAddProperty: (accountId) => entitlements.assertCanAddProperty(accountId),
    /**
     * The installation check fetches the customer's own site, so it goes through the DNS-pinned
     * outbound client rather than a bare `fetch` - a URL the customer typed is exactly the input
     * a server-side request forgery needs. The same setting that governs webhook targets governs
     * this one, so a deployment cannot end up with two different answers about private addresses.
     */
    fetchSite: createOutboundFetch({
      allowPrivateTargets: config.ALLOW_PRIVATE_WEBHOOK_URLS,
      // A home page, not a webhook acknowledgement: the snippet sits just before </body>, at the
      // end of the document, and the default cap was cutting it off on any page over 64KB.
      maxResponseBytes: 2 * 1024 * 1024,
    }),
    clock,
  });

  const billing = new BillingService({
    db,
    entitlements,
    settings,
    gateway: stripeGateway,
    appUrl: config.APP_URL,
    brand,
    deliver: deliverBillingMail,
    fallbackContactEmail: config.MAIL_FROM_ADDRESS,
  });
  const platformBilling = new PlatformBillingService({
    db,
    settings,
    entitlements,
    gateway: stripeGateway,
    apiUrl: config.API_URL,
    clock,
  });
  /**
   * The AI agent's configuration side.
   *
   * The API never asks a model for a reply - that is the worker's job - but it does index the
   * key facts an owner types (through the same knowledge service, which reaches the local
   * embedding model), and the console asks it whether the local model is up.
   */
  const accountAi = new AccountAiService({
    db,
    entitlements,
    encryptionKeyHex: config.SETTINGS_ENCRYPTION_KEY,
    baseUrl: config.AI_FALLBACK_BASE_URL || undefined,
    clock,
  });
  const aiGateway = createAiGateway(
    {
      url: config.AI_LOCAL_URL || undefined,
      chatModel: config.AI_CHAT_MODEL,
      embedModel: config.AI_EMBED_MODEL,
      embedDimensions: config.AI_EMBED_DIMENSIONS,
      parallel: config.AI_LOCAL_PARALLEL,
      fallbackBaseUrl: config.AI_FALLBACK_BASE_URL || undefined,
    },
    settings,
    { clock, log: (event, detail) => logger.warn(detail, event), accountRoute: (accountId) => accountAi.routeFor(accountId) },
  );
  const knowledge = new KnowledgeService({ db, gateway: aiGateway, appUrl: config.APP_URL, clock });
  const aiSettings = new AiSettingsService({ db, knowledge, queue, entitlements, clock });
  const aiFiles = new KnowledgeFileService({ db, storage, knowledge, queue, clock });
  const aiFeedback = new AiFeedbackService({ db, clock });
  const aiAnalytics = new AiAnalyticsService({ db });
  const aiReplies = new AiReplyService({
    db,
    knowledge,
    gateway: aiGateway,
    entitlements,
    events,
    clock,
    log: (event, detail) => logger.warn(detail, event),
  });
  const platformAi = new PlatformAiService({
    db,
    settings,
    gateway: aiGateway,
    local: {
      url: config.AI_LOCAL_URL,
      chatModel: config.AI_CHAT_MODEL,
      embedModel: config.AI_EMBED_MODEL,
      embedDimensions: config.AI_EMBED_DIMENSIONS,
    },
    fallbackBaseUrl: config.AI_FALLBACK_BASE_URL || undefined,
    clock,
  });
  // Articles feed the index. The hook is told after the write and never fails the write.
  kb.onArticleChanged = (accountId, articleId) =>
    aiSettings
      .onArticleChanged(accountId, articleId)
      .catch((error: unknown) => logger.error({ err: error, articleId }, 'knowledge sync failed'));

  const stripeWebhooks = async () => {
    const [gateway, stripe] = await Promise.all([stripeGateway(), settings.stripe()]);
    if (!gateway || !stripe?.webhookSecret) return null;
    return {
      webhookSecret: stripe.webhookSecret,
      service: new StripeWebhookService({
        db,
        entitlements,
        gateway,
        brand,
        deliver: deliverBillingMail,
        ownerOf,
        graceDays: () => settings.graceDays(),
        clock,
      }),
    };
  };

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
    geo,
    settings,
    entitlements,
    billing,
    platformBilling,
    aiSettings,
    aiFiles,
    aiFeedback,
    aiAnalytics,
    aiReplies,
    accountAi,
    platformAi,
    stripeGateway,
    stripeWebhooks,
    conversations,
    presence,
    connectionTickets,
    async shutdown() {
      await queue.close().catch(() => {});
      await mailer.close?.().catch(() => {});
      await db.$disconnect().catch(() => {});
      redis.disconnect();
      queueRedis.disconnect();
    },
  };
}
