import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signUploadSchema, confirmUploadSchema } from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody, parseParams } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Uploads, from the agent side.
 *
 * Two calls, because the bytes never pass through this service: it signs a target, the browser
 * PUTs to the store, and then it tells us it is done - at which point we read the object back and
 * decide what it actually is. Proxying the bytes would put a twenty-five megabyte body through the
 * API for no benefit; the verification happens either way.
 */
export async function uploadRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.post('/uploads/sign', async (request, reply) => {
    const tenant = requireTenant(request);
    await app.rateLimit(request, 'mutation', tenant.memberId);
    const input = parseBody(signUploadSchema, request.body);
    return ok(reply, await container.attachments.signForAgent(tenant, input));
  });

  app.post('/uploads/:id/confirm', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(confirmUploadSchema, request.body);
    const result = await container.attachments.confirmForAgent(tenant, id, input);
    return ok(reply, result);
  });

  /**
   * A short-lived URL for one file.
   *
   * Minted per request against the caller's own access rather than stored anywhere, so a link
   * cannot outlive the permission that produced it.
   */
  app.get('/attachments/:id/url', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const url = await container.attachments.downloadUrlForAgent(tenant, id);
    reply.header('cache-control', 'no-store');
    return ok(reply, { url, expiresInSeconds: 600 });
  });
}
