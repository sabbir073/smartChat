import type { FastifyInstance } from 'fastify';
import {
  agentReportSchema,
  articleReportSchema,
  overviewReportSchema,
  rebuildReportSchema,
} from '@smartchat/validation';
import { Permission } from '@smartchat/types';
import { requirePermission } from '@smartchat/core';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody, parseQuery } from '../lib/validate.js';

/** A `YYYY-MM-DD` from the client, read as that day rather than as an instant. */
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Reports.
 *
 * Every number here is read from the rollup tables, which are derived from the source tables and
 * can be rebuilt at any time. Nothing is computed live over messages: a report that gets slower
 * as an account gets busier is a report that stops being opened.
 */
export async function reportRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/reports/overview', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(overviewReportSchema, request.query);
    return ok(
      reply,
      await container.analytics.overview(tenant, {
        from: day(query.from),
        to: day(query.to),
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
      }),
    );
  });

  app.get('/reports/agents', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(agentReportSchema, request.query);
    return ok(
      reply,
      await container.analytics.agents(tenant, { from: day(query.from), to: day(query.to) }),
    );
  });

  app.get('/reports/articles', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(articleReportSchema, request.query);
    return ok(
      reply,
      await container.analytics.articles(tenant, {
        limit: query.limit,
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
      }),
    );
  });

  /**
   * Recompute a range now.
   *
   * The scheduled job keeps recent days current; this exists for the case the job is for - a
   * correction. Somebody fixes data, or a bug in the rollup is fixed, and the numbers have to be
   * repairable without waiting a quarter of an hour or editing the table by hand.
   *
   * It needs `account:update` rather than `report:view`, because it is a write that reads every
   * conversation in the range: expensive, and not something an agent should be able to start.
   */
  app.post('/reports/rebuild', async (request, reply) => {
    const tenant = requireTenant(request);
    requirePermission(tenant, Permission.ACCOUNT_UPDATE);
    const input = parseBody(rebuildReportSchema, request.body);
    const result = await container.analytics.rebuild(
      tenant.accountId,
      day(input.from),
      day(input.to),
    );
    return ok(reply, result);
  });
}
