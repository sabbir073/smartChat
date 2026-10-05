import { createServer } from 'node:http';
import { Worker, type Job } from 'bullmq';
import {
  AccountAiService,
  AiReplyService,
  CallService,
  ConversationService,
  EmailJob,
  EntitlementService,
  FeatureFlagService,
  KnowledgeService,
  LiveKitRooms,
  PlatformSettingsService,
  PrismaCallStore,
  QueueName,
  QueueProducer,
  RedisEventPublisher,
  TicketService,
  VoiceJob,
  VoiceSettingsService,
  WebhookService,
  createAiGateway,
  createRedisClient,
  postBotMessage,
  type MailDeliver,
  type VoiceAiJoinPayload,
} from '@smartchat/core';
import { createPrismaClient } from '@smartchat/database';
import { createLogger, withLogContext } from '@smartchat/logger';
import { loadVoiceConfig, mediaSocketUrl } from './config.js';
import { AiCallCounter } from './counter.js';
import { CallEventBus } from './events.js';
import { CallSession, type SessionDeps } from './session.js';
import { SpeechClient } from './speech-client.js';
import { createCallTicket } from './tickets.js';

/**
 * The voice agent.
 *
 * A worker like the other one, with one queue and one kind of job: join this call as the AI.
 * A job lasts as long as the call - minutes, not milliseconds - so the process keeps as many
 * running as the machine can carry (`VOICE_AI_MAX_CALLS`, which the call service also reads
 * before it hands a call over) and reports them on `/health` for whoever wonders what the AI
 * is doing right now. Everything the session needs from the rest of the system is built here
 * exactly as the worker and the API build it, so a ticket raised on the phone and a ticket
 * raised in the chat are the same ticket.
 */

const config = loadVoiceConfig();

const logger = createLogger({
  service: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

/** How long the speech service is given at boot to load its models before that is reported. */
const SPEECH_WARMUP = { attempts: 30, intervalMs: 2_000 };

async function main(): Promise<void> {
  const db = createPrismaClient({
    databaseUrl: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    onWarning: (message) => logger.warn({ message }, 'database warning'),
  });

  // BullMQ uses blocking reads, so it needs its own connection with retries disabled.
  const connection = createRedisClient({
    url: config.REDIS_URL,
    maxRetriesPerRequest: null,
    onError: (error) => logger.error({ err: error, connection: 'queue' }, 'redis error'),
  });
  // Commands - the call counter, the call service's claims - on a client of their own.
  const redis = createRedisClient({
    url: config.REDIS_URL,
    onError: (error) => logger.error({ err: error, connection: 'command' }, 'redis error'),
  });
  // A subscriber is good for nothing else once it subscribes; it gets its own connection too.
  const subscriber = createRedisClient({
    url: config.REDIS_URL,
    // No ready check: it is an INFO command, and a client that has subscribed may send nothing
    // but subscriber commands - the check then fails on every reconnect with an error that
    // means nothing.
    enableReadyCheck: false,
    onError: (error) => logger.error({ err: error, connection: 'events-sub' }, 'redis error'),
  });

  const voiceReady = Boolean(
    config.VOICE_ENABLED &&
    config.LIVEKIT_API_URL &&
    config.LIVEKIT_PUBLIC_URL &&
    config.SPEECH_URL,
  );
  if (!voiceReady) {
    logger.warn(
      'calling is not enabled here (VOICE_ENABLED, LIVEKIT_*, SPEECH_URL) - the voice agent will idle',
    );
  }

  const queue = new QueueProducer(connection);
  const events = new RedisEventPublisher(redis, (error) =>
    logger.error({ err: error }, 'failed to publish domain event'),
  );

  /**
   * The brain: the same AI layer as the worker's, built the same way, so a question asked on
   * the phone is answered from the same knowledge with the same rules as one typed in the chat.
   * No lifecycle service: the timers that nudge and close a chat have no meaning on a call.
   */
  const settings = new PlatformSettingsService(db, config.SETTINGS_ENCRYPTION_KEY);
  const entitlements = new EntitlementService({ db, graceDays: () => settings.graceDays() });
  const accountAi = new AccountAiService({
    db,
    entitlements,
    encryptionKeyHex: config.SETTINGS_ENCRYPTION_KEY,
    baseUrl: config.AI_FALLBACK_BASE_URL || undefined,
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
    {
      log: (event, detail) => logger.warn(detail, event),
      accountRoute: (accountId) => accountAi.routeFor(accountId),
    },
  );
  const knowledge = new KnowledgeService({ db, gateway: aiGateway, appUrl: config.APP_URL });
  const aiReplies = new AiReplyService({
    db,
    knowledge,
    gateway: aiGateway,
    entitlements,
    events,
    log: (event, detail) => logger.warn(detail, event),
  });

  /**
   * Tickets, raised the way the API raises them: a delivery row first, then the email through
   * the queue, so a receipt that never left is a row that says so rather than a silence.
   */
  const brand = {
    productName: config.PRODUCT_NAME,
    appUrl: config.APP_URL,
    supportEmail: config.MAIL_FROM_ADDRESS,
  };
  const flags = new FeatureFlagService(db);
  const webhooks = new WebhookService({
    assertIntegrationsAllowed: (accountId) => entitlements.assertFeature(accountId, 'integrations'),
    db,
    flags,
  });
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
  const tickets = new TicketService({ db, brand, deliver: deliverTicketMail, webhooks });

  const voiceSettings = new VoiceSettingsService({ db, entitlements });
  const calls = new CallService({
    store: new PrismaCallStore(db),
    media: new LiveKitRooms({
      apiUrl: config.LIVEKIT_API_URL,
      publicUrl: config.LIVEKIT_PUBLIC_URL,
      apiKey: config.LIVEKIT_API_KEY,
      apiSecret: config.LIVEKIT_API_SECRET,
    }),
    settings: voiceSettings,
    entitlements,
    events,
    queue,
    redis,
    conversations: new ConversationService({ db, events }),
    aiMaxCalls: config.VOICE_AI_MAX_CALLS,
    log: (event, detail) => logger.info(detail, event),
  });

  const speech = new SpeechClient({
    url: config.SPEECH_URL,
    ...(config.SPEECH_TOKEN ? { token: config.SPEECH_TOKEN } : {}),
    log: (event, detail) => logger.warn(detail, event),
  });
  const bus = new CallEventBus({ subscriber, log: (event, detail) => logger.warn(detail, event) });
  const counter = new AiCallCounter(redis);

  /**
   * Say at boot whether the ears and mouth are there.
   *
   * The speech service loads its models for twenty seconds or so after it starts, and on a
   * first boot it downloads them first. Waiting here, with the answer in the log, means a
   * deploy shows "speech ready" or the reason it is not - and not a first call that fails for
   * a reason only the other container's log knows. Not fatal: the service may simply be slower
   * than the wait, and a session that finds it missing ends that one call cleanly.
   */
  let speechStatus: 'ready' | 'loading' | 'down' = 'down';
  if (voiceReady) {
    const health = await speech.waitUntilReady(SPEECH_WARMUP);
    speechStatus = health.ok ? 'ready' : health.status === 503 ? 'loading' : 'down';
    if (health.ok) logger.info({ speech: health.body }, 'speech service ready');
    else
      logger.error(
        { status: health.status, body: health.body },
        'speech service not ready - calls will fail until it is',
      );
    await bus.start();
  }

  const mediaUrl = mediaSocketUrl(config.LIVEKIT_API_URL, config.LIVEKIT_PUBLIC_URL);
  const sessionDeps: SessionDeps = {
    calls,
    voiceSettings,
    aiReplies,
    visitors: {
      find: (accountId, visitorId) =>
        db.visitor.findFirst({
          where: { accountId, id: visitorId },
          select: { name: true, email: true },
        }),
    },
    transcript: { post: (input) => postBotMessage(db, events, input) },
    tickets: { create: (input) => createCallTicket({ db, tickets }, input) },
    bus,
    speech,
    counter,
    mediaUrl,
    logger,
  };
  const sessions = new Map<string, CallSession>();

  /**
   * One session per job, for as long as the call lasts. A job for a call this process is
   * already on - a retried delivery - is dropped; the running session is the truth. A session
   * never throws once it is in the room, so a failure on one call is a log line and a clean
   * end for that call, not a retry and not a crash.
   */
  const worker = voiceReady
    ? new Worker(
        QueueName.VOICE_AI,
        (job: Job<VoiceAiJoinPayload>) =>
          withLogContext(
            { jobId: job.id ?? undefined, accountId: job.data.accountId },
            async () => {
              if (job.name !== VoiceJob.AI_JOIN) {
                logger.warn({ name: job.name }, 'unknown voice ai job');
                return;
              }
              if (sessions.has(job.data.callId)) {
                logger.warn(
                  { callId: job.data.callId },
                  'already on this call - duplicate job dropped',
                );
                return;
              }
              const session = new CallSession(sessionDeps, job.data);
              sessions.set(job.data.callId, session);
              try {
                await session.run();
              } finally {
                sessions.delete(job.data.callId);
              }
            },
          ),
        // As many calls at once as the machine was sized for. The cap is also enforced by the
        // call service before a job is ever queued; this is the second lock on the same door.
        { connection, concurrency: Math.max(1, config.VOICE_AI_MAX_CALLS) },
      )
    : null;
  worker?.on('failed', (job, error) => {
    const willRetry = (job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 1);
    logger.error(
      {
        jobId: job?.id,
        callId: (job?.data as { callId?: string } | undefined)?.callId,
        willRetry,
        err: error,
      },
      willRetry ? 'ai join failed - will retry' : 'ai join failed permanently',
    );
  });
  worker?.on('error', (error) => logger.error({ err: error }, 'worker error'));

  /**
   * The health server. `/health` is "the process is up" plus who the AI is talking to right
   * now; `/ready` is "it could take a call": the database, Redis and - because an agent without
   * ears is no agent - the speech service, probed on demand and cached briefly so a frequent
   * check does not become load on the service that renders the voices.
   */
  let speechProbe: { at: number; ok: boolean } | null = null;
  const probeSpeech = async (): Promise<boolean> => {
    if (!voiceReady) return false;
    if (speechProbe && Date.now() - speechProbe.at < 10_000) return speechProbe.ok;
    const ok = await speech
      .health(3_000)
      .then((health) => health.ok)
      .catch(() => false);
    speechProbe = { at: Date.now(), ok };
    speechStatus = ok ? 'ready' : 'down';
    return ok;
  };
  const health = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          service: config.SERVICE_NAME,
          enabled: voiceReady,
          speech: speechStatus,
          maxCalls: config.VOICE_AI_MAX_CALLS,
          sessions: [...sessions.values()].map((session) => session.snapshot()),
        }),
      );
      return;
    }
    if (request.url === '/ready') {
      Promise.allSettled([db.$queryRaw`SELECT 1`, redis.ping(), probeSpeech()])
        .then(([database, cache, speechOk]) => {
          const healthy =
            database.status === 'fulfilled' &&
            cache.status === 'fulfilled' &&
            (!voiceReady || (speechOk.status === 'fulfilled' && speechOk.value));
          response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              status: healthy ? 'ready' : 'degraded',
              speech: speechStatus,
              sessions: sessions.size,
            }),
          );
        })
        .catch(() => {
          response.writeHead(503).end();
        });
      return;
    }
    response.writeHead(404).end();
  });
  health.listen(config.PORT);

  logger.info(
    { port: config.PORT, maxCalls: config.VOICE_AI_MAX_CALLS, enabled: voiceReady, mediaUrl },
    'voice agent started',
  );

  /**
   * Going down: every live call is ended as a failure - the call service records it and the
   * visitor's screen says so - rather than left in a room with nobody in it. No goodbye is
   * spoken: a process with seconds to live should not start rendering one.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal, sessions: sessions.size }, 'shutting down');
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out - exiting');
      process.exit(1);
    }, 20_000);
    timeout.unref();

    health.close();
    await Promise.all([...sessions.values()].map((session) => session.shutdown()));
    if (worker) await worker.close();
    await bus.stop();
    await queue.close();
    await db.$disconnect();
    connection.disconnect();
    redis.disconnect();
    subscriber.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled rejection'),
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'voice agent failed to start');
  process.exit(1);
});
