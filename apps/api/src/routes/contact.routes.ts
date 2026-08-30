import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createContactFieldSchema,
  listContactsSchema,
  updateContactFieldSchema,
  updateContactSchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toContactDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Contacts: the people, rather than the browsers.
 *
 * Everything here is tenant-scoped by the preHandler. The history route additionally applies the
 * caller's property scope - a restricted agent sees the whole person but only the parts of their
 * history that happened on a website they work on.
 */
export async function contactRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/contacts', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(listContactsSchema, request.query);
    const page = await container.contacts.list(tenant, query);
    return ok(reply, page.items.map(toContactDto), page.meta as unknown as Record<string, unknown>);
  });

  app.get('/contacts/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, toContactDto(await container.contacts.get(tenant, id)));
  });

  app.get('/contacts/:id/history', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const history = await container.contacts.history(tenant, id);
    return ok(reply, {
      contact: toContactDto(history.contact),
      conversations: history.conversations,
      files: history.files,
    });
  });

  app.patch('/contacts/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateContactSchema, request.body);
    return ok(reply, toContactDto(await container.contacts.update(tenant, id, input)));
  });

  // --- the fields an account decides to keep ---------------------------------

  app.get('/contacts-fields', async (request, reply) => {
    const tenant = requireTenant(request);
    const fields = await container.contacts.listFields(tenant);
    return ok(
      reply,
      fields.map((field) => ({
        id: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        position: field.position,
      })),
    );
  });

  app.post('/contacts-fields', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createContactFieldSchema, request.body);
    const field = await container.contacts.createField(tenant, input);
    return created(reply, { id: field.id, key: field.key, label: field.label, type: field.type });
  });

  app.patch('/contacts-fields/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateContactFieldSchema, request.body);
    const field = await container.contacts.updateField(tenant, id, input);
    return ok(reply, { id: field.id, key: field.key, label: field.label, type: field.type });
  });

  app.delete('/contacts-fields/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.contacts.deleteField(tenant, id);
    return noContent(reply);
  });
}
