import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { annualSavingMonths } from '@smartchat/core';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody, parseParams } from '../lib/validate.js';

const changePlanSchema = z.object({
  planCode: z.string().trim().min(1).max(40),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
});

/**
 * A plan as the outside world sees it.
 *
 * Deliberately narrow. The pricing page is public, so this shape is the boundary between "what a
 * plan is" and "what a stranger may know about our commercial model": the entitlements are
 * included because they are the product promise, and nothing else is.
 */
export interface PublicPlanDto {
  code: string;
  name: string;
  tagline: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  isContactSales: boolean;
  /** Whole months saved by paying annually. Zero on a free plan. */
  annualSavingMonths: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
}

/**
 * Billing, in three audiences.
 *
 * `/public/plans` is for the marketing site and needs no credential at all. `/billing/*` is the
 * customer's own subscription. The operator's side lives in platform.routes.ts, behind a different
 * cookie and a different principal - a tenant session must never be able to approve its own plan
 * change, which is exactly why the approval endpoint is not in this file.
 */
export async function billingRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/billing/subscription', async (request, reply) => {
    const tenant = requireTenant(request);
    return ok(reply, await container.subscriptions.overview(tenant));
  });

  app.get('/billing/invoices', async (request, reply) => {
    const tenant = requireTenant(request);
    const invoices = await container.subscriptions.invoices(tenant);
    return ok(
      reply,
      invoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        planName: invoice.planName,
        interval: invoice.interval,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        status: invoice.status,
        periodStart: invoice.periodStart.toISOString(),
        periodEnd: invoice.periodEnd.toISOString(),
        issuedAt: invoice.issuedAt.toISOString(),
        paidAt: invoice.paidAt?.toISOString() ?? null,
        reference: invoice.reference,
      })),
    );
  });

  app.post('/billing/plan', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(changePlanSchema, request.body);
    const result = await container.subscriptions.requestChange(tenant, input);
    return ok(reply, result);
  });

  app.delete('/billing/plan/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(z.object({ id: z.string().uuid() }), request.params);
    await container.subscriptions.withdrawChange(tenant, id);
    return ok(reply, { withdrawn: true });
  });

  app.post('/billing/cancel', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(
      z.object({ immediately: z.boolean().default(false) }),
      request.body ?? {},
    );
    await container.subscriptions.cancel(tenant, input.immediately);
    return ok(reply, { cancelled: true });
  });

  app.post('/billing/resume', async (request, reply) => {
    const tenant = requireTenant(request);
    await container.subscriptions.resume(tenant);
    return ok(reply, { resumed: true });
  });
}

/**
 * The pricing page's data source. No credential, no account, no cookie.
 *
 * Registered in its own scope with no authentication hook, for the same reason the public help
 * centre is: relying on a hook being skipped is one edit away from being wrong.
 */
export async function publicPlanRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  app.get('/public/plans', async (_request, reply) => {
    const plans = await container.db.plan.findMany({
      where: { isPublic: true },
      include: { features: true },
      orderBy: { sortOrder: 'asc' },
    });

    const dto: PublicPlanDto[] = plans.map((plan) => {
      const limits: Record<string, number | null> = {};
      const features: Record<string, boolean> = {};
      for (const feature of plan.features) {
        if (feature.boolValue !== null) features[feature.key] = feature.boolValue;
        else limits[feature.key] = feature.limitValue === null ? null : Number(feature.limitValue);
      }

      return {
        code: plan.code,
        name: plan.name,
        tagline: plan.tagline,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceYearlyCents: plan.priceYearlyCents,
        currency: plan.currency,
        isContactSales: plan.isContactSales,
        annualSavingMonths: annualSavingMonths(plan),
        limits,
        features,
      };
    });

    // Prices change rarely and this is the busiest page on the marketing site. A minute is short
    // enough that a price change is live before anybody notices, and long enough to matter.
    reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return ok(reply, dto);
  });
}
