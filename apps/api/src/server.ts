import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createLogger } from '@smartchat/logger';
import type { ApiConfig } from './config.js';
import { createContainer, type Container } from './container.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { healthPlugin } from './plugins/health.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestContextPlugin } from './plugins/request-context.js';
import { securityPlugin } from './plugins/security.js';
import { registerRoutes } from './routes/index.js';

export interface BuiltServer {
  app: FastifyInstance;
  container: Container;
}

export async function buildServer(config: ApiConfig): Promise<BuiltServer> {
  const logger = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const container = createContainer(config, logger);

  const app = Fastify({
    // pino's Logger is structurally a FastifyBaseLogger; the cast keeps Fastify's generic
    // parameters at their defaults so plugins typed against FastifyInstance still compose.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Fastify's default request id is a per-process counter, which collides across replicas.
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
  });

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, { config });
  await app.register(rateLimitPlugin, {
    limiter: container.rateLimiter,
    enabled: config.RATE_LIMIT_ENABLED,
  });
  await app.register(authPlugin, { container });
  await app.register(healthPlugin, { container });

  await registerRoutes(app, container);

  app.addHook('onClose', async () => {
    await container.shutdown();
  });

  return { app, container };
}
