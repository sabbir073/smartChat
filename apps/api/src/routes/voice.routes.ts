import type { FastifyInstance } from 'fastify';
import { AppError, ErrorCode } from '@smartchat/types';
import {
  callParamSchema,
  listCallsSchema,
  transferCallSchema,
  updateVoiceSettingsSchema,
  uuidSchema,
} from '@smartchat/validation';
import { z } from 'zod';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';

const propertyParam = z.object({ id: uuidSchema });

/**
 * Voice calls, from the team's side.
 *
 * Every route is tenant-scoped by the preHandler; the call service checks the permission and the
 * website scope on every call. There is no listing of other accounts' calls, no token for a room
 * one is not party to, and nothing here is reachable without a session.
 *
 * `calls` is null when calling is switched off for the installation; the settings routes still
 * work so the page can say so.
 */
export async function voiceRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  // --- settings, per website ---------------------------------------------------
  app.get('/properties/:id/voice', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(propertyParam, request.params);
    const settings = await container.voiceSettings.get(tenant, id);
    return ok(reply, { ...settings, available: container.calls !== null });
  });

  app.patch('/properties/:id/voice', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(propertyParam, request.params);
    const input = parseBody(updateVoiceSettingsSchema, request.body);
    const settings = await container.voiceSettings.update(tenant, id, input);
    return ok(reply, { ...settings, available: container.calls !== null });
  });

  // --- calls -----------------------------------------------------------------
  app.get('/calls', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(listCallsSchema, request.query);
    const calls = container.calls ? await container.calls.list(tenant, query) : [];
    return ok(reply, calls);
  });

  app.get('/calls/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    return ok(reply, await requireCalls(container).get(tenant, id));
  });

  app.get('/calls/:id/targets', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    return ok(reply, await requireCalls(container).transferTargets(tenant, id));
  });

  app.post('/calls/:id/answer', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    reply.header('cache-control', 'no-store');
    return ok(reply, await requireCalls(container).answer(tenant, id));
  });

  app.post('/calls/:id/decline', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    return ok(reply, await requireCalls(container).decline(tenant, id));
  });

  app.post('/calls/:id/joined', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    return ok(reply, await requireCalls(container).joined(tenant, id));
  });

  app.post('/calls/:id/transfer', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    const input = parseBody(transferCallSchema, request.body);
    return ok(reply, await requireCalls(container).transfer(tenant, id, input));
  });

  app.post('/calls/:id/end', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(callParamSchema, request.params);
    return ok(reply, await requireCalls(container).endByMember(tenant, id));
  });
}

/**
 * The media server's webhook: who joined, who left, when a room closed.
 *
 * Its own scope with a raw body parser, because the signature covers the exact bytes. The event
 * is read through the media adapter, which checks the signature with the API secret; a request
 * that does not verify is refused before anything is looked up.
 */
export async function voiceWebhookRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/voice/media/webhook', async (request, reply) => {
    await app.rateLimit(request, 'mediaWebhook');
    if (!container.media || !container.calls) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Calling is not enabled on this installation');
    }
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new AppError(ErrorCode.MALFORMED_REQUEST, 'Expected a raw request body');
    }
    const authorization = request.headers['authorization'];
    let event;
    try {
      event = await container.media.readWebhook(
        body.toString('utf8'),
        typeof authorization === 'string' ? authorization : undefined,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'media webhook refused');
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Webhook signature did not verify');
    }
    await container.calls.onMediaEvent(event);
    return ok(reply, { received: true });
  });
}

function requireCalls(container: Container) {
  if (!container.calls) {
    throw new AppError(
      ErrorCode.FEATURE_NOT_AVAILABLE,
      'Calling is not enabled on this installation',
    );
  }
  return container.calls;
}
