import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createShortcutSchema,
  createTriggerSchema,
  updateShortcutSchema,
  updateTriggerSchema,
  TRIGGER_FIELD_TYPES,
  OPERATORS_BY_TYPE,
  SHORTCUT_PLACEHOLDERS,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toShortcutDto, toTriggerDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Automation: the rules that message people, and the replies agents reuse.
 *
 * Both are ordinary tenant-scoped resources. The interesting part is what they are *not*: there is
 * no endpoint that fires a trigger. Rules run from the gateway, against a live visitor, because a
 * rule that could be fired by an HTTP call would be a way to make somebody's widget say whatever
 * the caller liked.
 */
export async function automationRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  /**
   * What the rule builder can offer.
   *
   * Served rather than duplicated in the dashboard, so the fields and operators a customer is
   * shown are exactly the ones the engine will accept.
   */
  app.get('/automation/schema', async (request, reply) => {
    requireTenant(request);
    return ok(reply, {
      fields: Object.entries(TRIGGER_FIELD_TYPES).map(([field, type]) => ({
        field,
        type,
        operators: OPERATORS_BY_TYPE[type],
      })),
      placeholders: SHORTCUT_PLACEHOLDERS,
    });
  });

  // --- triggers -------------------------------------------------------------

  app.get('/automation/triggers', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(z.object({ propertyId: z.string().uuid().optional() }), request.query);
    const triggers = await container.automation.listTriggers(tenant, query);
    return ok(reply, triggers.map(toTriggerDto));
  });

  app.get('/automation/triggers/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const trigger = await container.automation.getTrigger(tenant, id);
    return ok(reply, toTriggerDto(trigger));
  });

  app.post('/automation/triggers', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createTriggerSchema, request.body);
    const trigger = await container.automation.createTrigger(tenant, input);
    return created(reply, toTriggerDto(trigger));
  });

  app.patch('/automation/triggers/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateTriggerSchema, request.body);
    const trigger = await container.automation.updateTrigger(tenant, id, input);
    return ok(reply, toTriggerDto(trigger));
  });

  app.delete('/automation/triggers/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.automation.deleteTrigger(tenant, id);
    return noContent(reply);
  });

  // --- shortcuts ------------------------------------------------------------

  app.get('/automation/shortcuts', async (request, reply) => {
    const tenant = requireTenant(request);
    const shortcuts = await container.automation.listShortcuts(tenant);
    return ok(reply, shortcuts.map(toShortcutDto));
  });

  app.post('/automation/shortcuts', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createShortcutSchema, request.body);
    const shortcut = await container.automation.createShortcut(tenant, input);
    return created(reply, toShortcutDto(shortcut));
  });

  app.patch('/automation/shortcuts/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateShortcutSchema, request.body);
    const shortcut = await container.automation.updateShortcut(tenant, id, input);
    return ok(reply, toShortcutDto(shortcut));
  });

  app.delete('/automation/shortcuts/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.automation.deleteShortcut(tenant, id);
    return noContent(reply);
  });

  /** Counting a use is what orders the picker by what the team actually reaches for. */
  app.post('/automation/shortcuts/:id/used', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.automation.recordShortcutUse(tenant, id);
    return noContent(reply);
  });
}
