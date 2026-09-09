import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addDomainSchema,
  createPropertySchema,
  listPropertiesSchema,
  updateAiSettingsSchema,
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
      page.items.map((property) => toPropertyDto(property)),
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

  /**
   * Check the installation on demand.
   *
   * A POST because it makes an outbound request to the customer's own site and can write
   * `installedAt`, neither of which belongs behind a GET somebody's browser might prefetch.
   */
  app.post('/properties/:id/install/verify', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    // Fetching somebody's website on request is a small amplification primitive, so it is rate
    // limited per caller rather than left to the general write budget.
    await app.rateLimit(request, 'installVerify', `property:${id}`);
    return ok(reply, await container.properties.verifyInstallation(tenant, id));
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

  // --- the AI agent ------------------------------------------------------------------

  app.get('/properties/:id/ai', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, await container.aiSettings.get(tenant, id));
  });

  app.patch('/properties/:id/ai', async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'mutation', `account:${tenant.accountId}`);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateAiSettingsSchema, request.body);
    return ok(reply, await container.aiSettings.update(tenant, id, input));
  });

  /** Rebuild the knowledge index from every published article and the key facts. */
  app.post('/properties/:id/ai/reindex', async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'aiReindex', `account:${tenant.accountId}`);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, await container.aiSettings.reindex(tenant, id));
  });
}
