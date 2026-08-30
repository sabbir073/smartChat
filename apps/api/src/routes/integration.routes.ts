import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createApiKeySchema,
  createWebhookSchema,
  developmentWebhookUrlSchema,
  updateWebhookSchema,
} from '@smartchat/validation';
import { AppError, ErrorCode } from '@smartchat/types';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toApiKeyDto, toWebhookDeliveryDto, toWebhookDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The URL rule, relaxed only where configuration says so.
 *
 * Built once per boot from the config rather than checked per request, so there is no path where a
 * header, a body field or a query parameter can widen it.
 */
function webhookSchemas(allowPrivate: boolean) {
  return allowPrivate
    ? {
        create: createWebhookSchema.extend({ url: developmentWebhookUrlSchema }),
        update: updateWebhookSchema,
      }
    : { create: createWebhookSchema, update: updateWebhookSchema };
}

/**
 * Keys and webhooks.
 *
 * Managed only from the dashboard, by a person with a session. A key that could mint another key
 * would make revocation meaningless - revoke one and its children keep working - so this whole
 * scope refuses API-key authentication outright rather than relying on scopes never being wide
 * enough to reach it.
 */
export async function integrationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const schemas = webhookSchemas(container.config.ALLOW_PRIVATE_WEBHOOK_URLS);

  app.addHook('preHandler', app.authenticateTenant);
  app.addHook('preHandler', async (request) => {
    const tenant = requireTenant(request);
    if (tenant.actorType === 'api_key') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'API keys and webhooks are managed from the dashboard, not through the API',
      );
    }
  });

  app.get('/integrations/keys', async (request, reply) => {
    const tenant = requireTenant(request);
    const keys = await container.apiKeys.list(tenant);
    return ok(reply, keys.map(toApiKeyDto));
  });

  app.post('/integrations/keys', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createApiKeySchema, request.body);
    const result = await container.apiKeys.create(tenant, input);
    // The only response that will ever contain the secret. Said plainly in the field name.
    return created(reply, { ...toApiKeyDto(result.key), secretShownOnce: result.secret });
  });

  app.delete('/integrations/keys/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.apiKeys.revoke(tenant, id);
    return noContent(reply);
  });

  app.get('/integrations/webhooks', async (request, reply) => {
    const tenant = requireTenant(request);
    const webhooks = await container.webhooks.list(tenant);
    return ok(reply, webhooks.map(toWebhookDto));
  });

  app.post('/integrations/webhooks', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(schemas.create, request.body);
    const result = await container.webhooks.create(tenant, input);
    return created(reply, { ...toWebhookDto(result.webhook), secretShownOnce: result.secret });
  });

  app.patch('/integrations/webhooks/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(schemas.update, request.body);
    return ok(reply, toWebhookDto(await container.webhooks.update(tenant, id, input)));
  });

  app.delete('/integrations/webhooks/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.webhooks.remove(tenant, id);
    return noContent(reply);
  });

  app.get('/integrations/webhooks/:id/deliveries', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const query = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      request.query,
    );
    const deliveries = await container.webhooks.deliveries(tenant, id, query.limit);
    return ok(reply, deliveries.map(toWebhookDeliveryDto));
  });

  /** Find out whether an endpoint works before it has to. */
  app.post('/integrations/webhooks/:id/ping', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const delivery = await container.webhooks.ping(tenant, id);
    return created(reply, toWebhookDeliveryDto(delivery));
  });
}
