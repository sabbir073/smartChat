import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisChannel, ServerEvent, room, type DomainEventLike } from './types.js';
import { createLogger } from '@smartchat/logger';
import { loadRealtimeConfig } from './config.js';
import { createRealtimeContainer } from './container.js';
import { registerAgentNamespace } from './namespaces/agent.js';
import { registerVisitorNamespace } from './namespaces/visitor.js';

const config = loadRealtimeConfig();

const logger = createLogger({
  service: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

async function main(): Promise<void> {
  const container = createRealtimeContainer(config, logger);
  const startedAt = Date.now();

  /**
   * A tiny HTTP surface alongside the socket server.
   *
   * `/health` says only that the process is alive; `/ready` checks the dependencies the gateway
   * actually needs. Keeping them different is what stops a Redis blip from causing an orchestrator
   * to restart a gateway holding thousands of live connections.
   */
  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          service: config.SERVICE_NAME,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          connections: io?.engine.clientsCount ?? 0,
        }),
      );
      return;
    }
    if (request.url === '/ready') {
      Promise.allSettled([container.db.$queryRaw`SELECT 1`, container.redis.ping()])
        .then((results) => {
          const healthy = results.every((result) => result.status === 'fulfilled');
          response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: healthy ? 'ready' : 'degraded' }));
        })
        .catch(() => response.writeHead(503).end());
      return;
    }
    response.writeHead(404).end();
  });

  const io = new Server(httpServer, {
    // Long-polling is kept as a fallback, but WebSocket is tried first. Polling exists for the
    // small number of networks that break WebSocket outright, not as the normal path.
    transports: ['websocket', 'polling'],
    pingInterval: config.SOCKET_PING_INTERVAL_MS,
    pingTimeout: config.SOCKET_PING_TIMEOUT_MS,
    maxHttpBufferSize: config.SOCKET_MAX_PAYLOAD_BYTES,
    cors: {
      /**
       * Any origin, and deliberately so.
       *
       * Socket.IO negotiates the transport before it knows which namespace is being addressed, so
       * one policy has to cover both - and the visitor namespace must accept every customer
       * website, which we cannot enumerate.
       *
       * That is safe here precisely because `credentials` is false: no cookie is ever sent, the
       * single-use ticket in the handshake is the only credential, and a cross-origin page cannot
       * obtain one. Restricting the origin would give no additional protection while breaking the
       * widget on every customer domain.
       */
      origin: true,
      credentials: false,
    },
  });

  // The Redis adapter is what lets any instance deliver to a socket connected to any other.
  io.adapter(createAdapter(container.pubClient, container.subClient));

  registerVisitorNamespace(io.of('/visitor'), container);
  registerAgentNamespace(io.of('/agent'), container);

  /**
   * Fan domain events out to sockets.
   *
   * The API and the gateway both publish to this channel, so a message sent over HTTP reaches
   * connected clients by exactly the same route as one sent over a socket. There is no second code
   * path to keep in step.
   */
  await container.eventSubscriber.subscribe(RedisChannel.CONVERSATION_EVENTS);
  container.eventSubscriber.on('message', (channel: string, raw: string) => {
    if (channel !== RedisChannel.CONVERSATION_EVENTS) return;

    let event: DomainEventLike;
    try {
      event = JSON.parse(raw) as DomainEventLike;
    } catch {
      logger.warn('discarded a malformed domain event');
      return;
    }

    try {
      deliver(event);
    } catch (error) {
      logger.error({ err: error, type: event.type }, 'failed to deliver domain event');
    }
  });

  function deliver(event: DomainEventLike): void {
    const agents = io.of('/agent');
    const visitors = io.of('/visitor');

    if (event.conversationId) {
      agents.to(room.conversation(event.conversationId)).emit(event.type, event.payload);
      // An internal note carries content the visitor must never see. One flag decides it, in one
      // place, rather than each emit site remembering.
      if (!event.agentsOnly) {
        visitors.to(room.conversation(event.conversationId)).emit(event.type, event.payload);
      }
    }

    // Agents watching the property see inbox-level changes even with no conversation open.
    if (event.propertyId) {
      agents.to(room.property(event.propertyId)).emit(event.type, event.payload);
    }

    if (event.type === ServerEvent.CONVERSATION_CREATED && event.propertyId) {
      agents
        .to(room.property(event.propertyId))
        .emit(ServerEvent.CONVERSATION_CREATED, event.payload);
    }
  }

  await new Promise<void>((resolve) => httpServer.listen(config.PORT, config.HOST, resolve));
  logger.info({ port: config.PORT }, 'realtime gateway listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out - exiting');
      process.exit(1);
    }, 15_000);
    timeout.unref();

    // Closing the socket server disconnects clients cleanly, so they reconnect immediately to
    // another instance rather than waiting for a ping timeout to notice.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    httpServer.close();
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled rejection'),
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'realtime gateway failed to start');
  process.exit(1);
});
