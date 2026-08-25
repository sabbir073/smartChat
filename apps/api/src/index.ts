import { loadApiConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadApiConfig();

async function main(): Promise<void> {
  const { app } = await buildServer(config);

  /**
   * Graceful shutdown.
   *
   * Fastify stops accepting connections, finishes in-flight requests, then the container closes
   * the database, Redis and queue connections. The hard timeout exists so a stuck request cannot
   * hold a deploy open indefinitely.
   */
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    const timeout = setTimeout(() => {
      app.log.error('graceful shutdown timed out — exiting');
      process.exit(1);
    }, 15_000);
    timeout.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception — exiting');
    process.exit(1);
  });

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ port: config.PORT }, 'api listening');
}

main().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  process.exit(1);
});
