import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createTicketSchema,
  listTicketsSchema,
  replyToTicketSchema,
  updateTicketSchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toTicketDto, toTicketMessageDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Tickets.
 *
 * Every route here is tenant-scoped by the preHandler and property-scoped inside the service, so
 * a restricted agent working one website never sees another's queue. There is deliberately no
 * public surface: unlike the help centre, nothing about a ticket is safe to serve to a stranger.
 */
export async function ticketRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/tickets', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(listTicketsSchema, request.query);
    const page = await container.tickets.list(tenant, query);
    return ok(reply, page.items.map(toTicketDto), page.meta as unknown as Record<string, unknown>);
  });

  app.post('/tickets', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createTicketSchema, request.body);
    return created(reply, toTicketDto(await container.tickets.create(tenant, input)));
  });

  app.get('/tickets/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, toTicketDto(await container.tickets.get(tenant, id)));
  });

  app.patch('/tickets/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateTicketSchema, request.body);
    return ok(reply, toTicketDto(await container.tickets.update(tenant, id, input)));
  });

  app.delete('/tickets/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.tickets.remove(tenant, id);
    return noContent(reply);
  });

  app.get('/tickets/:id/messages', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const messages = await container.tickets.messages(tenant, id);
    return ok(reply, messages.map(toTicketMessageDto));
  });

  /**
   * Reply, or make a note.
   *
   * One route for both because they are the same act from the agent's point of view - writing
   * something onto a ticket - and splitting them into `/reply` and `/note` would let a client send
   * the wrong one without ever naming what it meant. Here the body has to say `visibility`, and
   * the schema has no default, so "public" is always something somebody chose.
   */
  app.post('/tickets/:id/messages', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(replyToTicketSchema, request.body);
    const message = await container.tickets.reply(tenant, id, input);
    return created(reply, toTicketMessageDto(message));
  });
}
