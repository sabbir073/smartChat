import type { FastifyInstance } from 'fastify';
import { billingEnquirySchema, checkoutSchema } from '@smartchat/validation';
import { AppError, ErrorCode } from '@smartchat/types';
import type { Container } from '../container.js';
import { requireTenant, requireUser } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody } from '../lib/validate.js';

/**
 * Billing, as an account sees it.
 *
 * Every route here is marked `skipBillingLock`: a locked account has to be able to reach the
 * page that unlocks it. Nothing else in the API carries that flag.
 */
export async function billingRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);
  const unlocked = { config: { skipBillingLock: true } };

  app.get('/billing', unlocked, async (request, reply) => {
    const tenant = requireTenant(request);
    return ok(reply, await container.billing.overview(tenant));
  });

  /** The lightweight version the app shell polls: am I locked, and is a warning due? */
  app.get('/billing/entitlements', unlocked, async (request, reply) => {
    const tenant = requireTenant(request);
    const entitlements = await container.entitlements.forAccount(tenant.accountId);
    return ok(reply, {
      plan: entitlements.plan,
      subscription: {
        status: entitlements.subscription.status,
        currentPeriodEnd: entitlements.subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: entitlements.subscription.cancelAtPeriodEnd,
      },
      usage: entitlements.usage,
      lock: {
        locked: entitlements.lock.locked,
        reason: entitlements.lock.reason,
        graceEndsAt: entitlements.lock.graceEndsAt?.toISOString() ?? null,
      },
    });
  });

  app.post('/billing/checkout', unlocked, async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'billingAction', `account:${tenant.accountId}`);
    const input = parseBody(checkoutSchema, request.body);
    // The email Stripe attaches to the customer: whoever is paying. An API key is not a person
    // and cannot buy anything.
    if (!request.currentUser) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Checkout needs a signed-in person, not an API key');
    }
    const user = requireUser(request);
    return ok(reply, await container.billing.startCheckout(tenant, input, user.email));
  });

  app.post('/billing/portal', unlocked, async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'billingAction', `account:${tenant.accountId}`);
    return ok(reply, await container.billing.openPortal(tenant));
  });

  app.post('/billing/enquiries', unlocked, async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'billingEnquiry', `account:${tenant.accountId}`);
    const input = parseBody(billingEnquirySchema, request.body);
    await container.billing.enquire(tenant, input);
    return ok(reply, { sent: true });
  });
}

/**
 * Stripe's webhook.
 *
 * Its own scope, with no session, no CSRF and no tenant: Stripe is the caller. The body is read
 * as raw bytes because the signature is over the bytes Stripe sent, and a body that has been
 * parsed and re-serialised is a different sequence of bytes with the same meaning and the wrong
 * signature. Everything about authenticity is the signature check inside the handler.
 */
export async function stripeWebhookRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/billing/webhooks/stripe', async (request, reply) => {
    await app.rateLimit(request, 'stripeWebhook');

    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Missing Stripe signature');
    }

    const webhooks = await container.stripeWebhooks();
    if (!webhooks) {
      // Stripe will retry, and the operator will see the failures in the Stripe dashboard until
      // the webhook secret is entered - which is the right place to notice.
      throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED, 'The Stripe webhook secret is not configured');
    }

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new AppError(ErrorCode.MALFORMED_REQUEST, 'Expected a raw request body');
    }

    const outcome = await webhooks.service.handle(body, signature, webhooks.webhookSecret);
    request.log.info({ outcome }, 'stripe webhook');
    return ok(reply, { received: true, ...outcome });
  });
}
