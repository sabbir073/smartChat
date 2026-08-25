import fp from 'fastify-plugin';
import type { Container } from '../container.js';

/**
 * Two endpoints with deliberately different jobs.
 *
 * `/health` says only "this process is alive" and touches nothing, so a database blip cannot make
 * the orchestrator restart a healthy API and turn a degradation into an outage. `/ready` checks
 * dependencies and is what the proxy and `depends_on` use to decide whether to send traffic.
 */
export const healthPlugin = fp<{ container: Container }>(
  async (app, options) => {
    const startedAt = Date.now();

    app.get('/health', async () => ({
      status: 'ok',
      service: options.container.config.SERVICE_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }));

    app.get('/ready', async (_request, reply) => {
      const checks: Record<string, 'ok' | 'error'> = {};

      const [database, redis] = await Promise.allSettled([
        options.container.db.$queryRaw`SELECT 1`,
        options.container.redis.ping(),
      ]);

      checks['database'] = database.status === 'fulfilled' ? 'ok' : 'error';
      checks['redis'] = redis.status === 'fulfilled' ? 'ok' : 'error';

      const healthy = Object.values(checks).every((value) => value === 'ok');
      return reply
        .status(healthy ? 200 : 503)
        .send({ status: healthy ? 'ready' : 'degraded', checks });
    });
  },
  { name: 'health' },
);
