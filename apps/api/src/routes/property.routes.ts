import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addDomainSchema,
  createPropertySchema,
  listPropertiesSchema,
  updatePropertySchema,
  updateWidgetConfigSchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toPropertyDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });
const domainParam = z.object({ id: z.string().uuid(), domainId: z.string().uuid() });

export async function propertyRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/properties', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(listPropertiesSchema, request.query);
    const page = await container.properties.list(tenant, query);
    return ok(
      reply,
      page.items.map(toPropertyDto),
      page.meta as unknown as Record<string, unknown>,
    );
  });

  app.post('/properties', async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'mutation', `account:${tenant.accountId}`);
    const input = parseBody(createPropertySchema, request.body);
    const property = await container.properties.create(tenant, input);
    return created(reply, toPropertyDto(property));
  });

  app.get('/properties/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, toPropertyDto(await container.properties.get(tenant, id)));
  });

  app.patch('/properties/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updatePropertySchema, request.body);
    return ok(reply, toPropertyDto(await container.properties.update(tenant, id, input)));
  });

  app.delete('/properties/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.properties.remove(tenant, id);
    return noContent(reply);
  });

  app.get('/properties/:id/install', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, await container.properties.installation(tenant, id));
  });

  app.post('/properties/:id/domains', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(addDomainSchema, request.body);
    return created(reply, toPropertyDto(await container.properties.addDomain(tenant, id, input)));
  });

  app.delete('/properties/:id/domains/:domainId', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id, domainId } = parseParams(domainParam, request.params);
    return ok(reply, toPropertyDto(await container.properties.removeDomain(tenant, id, domainId)));
  });

  // ---------------------------------------------------------------------------
  // Widget builder
  //
  // The builder edits a draft. Nothing a customer types reaches a visitor until they publish, so
  // a half-finished change is never live on their site.
  // ---------------------------------------------------------------------------

  app.get('/properties/:id/widget', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, await container.widgets.get(tenant, id));
  });

  app.patch('/properties/:id/widget', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateWidgetConfigSchema, request.body);
    return ok(reply, await container.widgets.saveDraft(tenant, id, input));
  });

  app.post('/properties/:id/widget/publish', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await app.rateLimit(request, 'mutation', `account:${tenant.accountId}`);
    return ok(reply, await container.widgets.publish(tenant, id));
  });

  app.post('/properties/:id/widget/discard', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, await container.widgets.discardDraft(tenant, id));
  });
}
