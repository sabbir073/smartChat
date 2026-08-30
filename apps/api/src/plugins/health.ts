import fp from 'fastify-plugin';
import { safeEqual } from '@smartchat/core';
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

    /**
     * Prometheus text format, behind a token.
     *
     * Every number here is counted from the database at scrape time rather than kept in a
     * process-local counter. That is slower and completely deliberate: this API runs as several
     * replicas, and a counter in one process answers "what did *this* container see since *its*
     * last restart" - a question nobody has, and one whose answer looks like an outage every time
     * a container is replaced.
     *
     * The queue backlogs are the ones worth alerting on. A `queued` email or a `pending` webhook
     * delivery that keeps climbing means the worker is not draining, which is invisible from the
     * outside: everything still returns 200 and nothing reaches anybody.
     */
    app.get('/metrics', async (request, reply) => {
      const expected = options.container.config.METRICS_TOKEN;
      if (!expected) return reply.status(404).send();

      const provided = request.headers.authorization;
      // Constant-time, because a token compared with `===` leaks its prefix to anybody patient.
      if (typeof provided !== 'string' || !safeEqual(provided, `Bearer ${expected}`)) {
        // 404, not 401: an endpoint that answers "wrong token" has confirmed it exists.
        return reply.status(404).send();
      }

      const started = Date.now();
      const [emails, webhooksPending, webhooksFailed, accounts, conversationsOpen] =
        await Promise.all([
          options.container.db.emailDelivery.count({ where: { status: 'queued' } }),
          options.container.db.webhookDelivery.count({ where: { status: 'pending' } }),
          options.container.db.webhookDelivery.count({ where: { status: 'failed' } }),
          options.container.db.account.count({ where: { deletedAt: null, status: 'active' } }),
          options.container.db.conversation.count({ where: { status: 'open', deletedAt: null } }),
        ]);

      const lines = [
        '# HELP smartchat_up 1 if this process is serving.',
        '# TYPE smartchat_up gauge',
        'smartchat_up 1',
        '# HELP smartchat_uptime_seconds Seconds since this process started.',
        '# TYPE smartchat_uptime_seconds gauge',
        `smartchat_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
        '# HELP smartchat_emails_queued Emails written but not yet sent.',
        '# TYPE smartchat_emails_queued gauge',
        `smartchat_emails_queued ${emails}`,
        '# HELP smartchat_webhook_deliveries_pending Deliveries due or awaiting retry.',
        '# TYPE smartchat_webhook_deliveries_pending gauge',
        `smartchat_webhook_deliveries_pending ${webhooksPending}`,
        '# HELP smartchat_webhook_deliveries_failed Deliveries given up on.',
        '# TYPE smartchat_webhook_deliveries_failed gauge',
        `smartchat_webhook_deliveries_failed ${webhooksFailed}`,
        '# HELP smartchat_accounts_active Active, non-deleted accounts.',
        '# TYPE smartchat_accounts_active gauge',
        `smartchat_accounts_active ${accounts}`,
        '# HELP smartchat_conversations_open Conversations currently open.',
        '# TYPE smartchat_conversations_open gauge',
        `smartchat_conversations_open ${conversationsOpen}`,
        '# HELP smartchat_metrics_scrape_seconds How long collecting these numbers took.',
        '# TYPE smartchat_metrics_scrape_seconds gauge',
        `smartchat_metrics_scrape_seconds ${((Date.now() - started) / 1000).toFixed(3)}`,
        '',
      ];

      return reply
        .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(lines.join('\n'));
    });
  },
  { name: 'health' },
);
