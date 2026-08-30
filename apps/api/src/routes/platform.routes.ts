import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCode } from '@smartchat/types';
import type { PlatformPrincipal } from '@smartchat/core';
import type { Container } from '../container.js';
import { noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import {
  PLATFORM_SESSION_COOKIE,
  clearPlatformSessionCookie,
  setPlatformSessionCookie,
} from '../lib/cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    platform: PlatformPrincipal | null;
  }
}

const accountParam = z.object({ id: z.string().uuid() });

/**
 * The platform console's API.
 *
 * Its own scope, its own cookie, its own principal - and deliberately no `TenantContext` anywhere.
 * That object exists to make tenant scoping impossible to forget, and an operator suspending an
 * account is not scoped to it. Reusing it here would either be a lie or would have to be defeated,
 * and both are worse than a separate path with its own permissions and its own audit trail.
 */
export async function platformRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.decorateRequest('platform', null);

  const cookieOptions = {
    secure: container.config.NODE_ENV === 'production',
    ...(container.config.COOKIE_DOMAIN ? { domain: container.config.COOKIE_DOMAIN } : {}),
  };

  function requirePlatform(request: FastifyRequest): PlatformPrincipal {
    if (!request.platform) throw new AppError(ErrorCode.UNAUTHENTICATED);
    return request.platform;
  }

  async function authenticate(request: FastifyRequest): Promise<void> {
    const token = request.cookies[PLATFORM_SESSION_COOKIE];
    if (!token) throw new AppError(ErrorCode.UNAUTHENTICATED);
    const principal = await container.platform.resolveSession(token);
    if (!principal) throw new AppError(ErrorCode.UNAUTHENTICATED);
    request.platform = principal;
  }

  // ---------------------------------------------------------------------------
  // Signing in. The only routes here that are not authenticated.
  // ---------------------------------------------------------------------------

  app.post('/platform/auth/login', async (request, reply) => {
    // The same throttle bucket as a tenant login. This is the most privileged credential in the
    // system; it does not get a gentler rate limit than everybody else's.
    await app.rateLimit(request, 'login');

    const input = parseBody(
      z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }),
      request.body,
    );

    const result = await container.platform.signIn({
      email: input.email,
      password: input.password,
      ip: request.clientIp,
      ...(typeof request.headers['user-agent'] === 'string'
        ? { userAgent: request.headers['user-agent'] }
        : {}),
    });

    setPlatformSessionCookie(
      reply,
      result.token,
      new Date(Date.now() + 8 * 60 * 60 * 1000),
      cookieOptions,
    );
    return ok(reply, {
      admin: {
        id: result.admin.id,
        email: result.admin.email,
        name: result.admin.name,
        permissions: result.admin.permissions,
      },
    });
  });

  app.post('/platform/auth/logout', async (request, reply) => {
    const token = request.cookies[PLATFORM_SESSION_COOKIE];
    if (token) await container.platform.signOut(token);
    clearPlatformSessionCookie(reply, cookieOptions);
    return noContent(reply);
  });

  app.get('/platform/auth/me', async (request, reply) => {
    await authenticate(request);
    const principal = requirePlatform(request);
    return ok(reply, {
      id: principal.adminId,
      email: principal.email,
      name: principal.name,
      permissions: [...principal.permissions],
    });
  });

  // ---------------------------------------------------------------------------

  await app.register(async (guarded) => {
    guarded.addHook('preHandler', authenticate);

    guarded.get('/platform/accounts', async (request, reply) => {
      const principal = requirePlatform(request);
      const query = parseQuery(
        z.object({
          search: z.string().trim().max(120).optional(),
          status: z.enum(['active', 'suspended', 'pending_deletion']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      return ok(reply, await container.platform.listAccounts(principal, query));
    });

    guarded.post('/platform/accounts/:id/suspend', async (request, reply) => {
      const principal = requirePlatform(request);
      const { id } = parseParams(accountParam, request.params);
      const input = parseBody(
        // Required, and not decoration: it is what the account's own people are shown.
        z.object({ reason: z.string().trim().min(4).max(300) }),
        request.body,
      );
      return ok(
        reply,
        await container.platform.suspendAccount(principal, id, input.reason, request.clientIp),
      );
    });

    guarded.post('/platform/accounts/:id/resume', async (request, reply) => {
      const principal = requirePlatform(request);
      const { id } = parseParams(accountParam, request.params);
      return ok(reply, await container.platform.resumeAccount(principal, id, request.clientIp));
    });

    guarded.get('/platform/accounts/:id/usage', async (request, reply) => {
      const principal = requirePlatform(request);
      const { id } = parseParams(accountParam, request.params);
      return ok(reply, await container.platform.usage(principal, id));
    });

    guarded.post('/platform/accounts/:id/plan', async (request, reply) => {
      const principal = requirePlatform(request);
      const { id } = parseParams(accountParam, request.params);
      const input = parseBody(
        z.object({ planCode: z.string().trim().min(1).max(60) }),
        request.body,
      );
      await container.platform.assignPlan(principal, id, input.planCode, request.clientIp);
      return noContent(reply);
    });

    guarded.get('/platform/plans', async (request, reply) => {
      return ok(reply, await container.platform.listPlans(requirePlatform(request)));
    });

    guarded.get('/platform/health', async (request, reply) => {
      return ok(reply, await container.platform.health(requirePlatform(request)));
    });

    guarded.get('/platform/flags', async (request, reply) => {
      return ok(reply, await container.platform.listFlags(requirePlatform(request)));
    });

    guarded.patch('/platform/flags/:key', async (request, reply) => {
      const principal = requirePlatform(request);
      const { key } = parseParams(z.object({ key: z.string().min(1).max(60) }), request.params);
      const input = parseBody(
        z
          .object({
            enabled: z.boolean().optional(),
            disabledAccountIds: z.array(z.string().uuid()).max(500).optional(),
          })
          .refine((value) => Object.keys(value).length > 0, 'Nothing to change'),
        request.body,
      );
      return ok(reply, await container.platform.setFlag(principal, key, input, request.clientIp));
    });

    /**
     * Apply data retention now.
     *
     * The nightly job does this on a schedule. This exists because the schedule is a promise, and
     * an operator who has just changed a policy - or who is answering a deletion request with a
     * deadline on it - needs to be able to say "and it has been applied", not "it will be, at four
     * tomorrow morning".
     */
    guarded.post('/platform/maintenance/retention', async (request, reply) => {
      const principal = requirePlatform(request);
      if (!principal.permissions.has('platform:settings:manage')) {
        throw new AppError(ErrorCode.FORBIDDEN, 'Your platform role does not include that');
      }
      const outcome = await container.retention.apply();
      return ok(reply, outcome);
    });

    guarded.get('/platform/audit', async (request, reply) => {
      const principal = requirePlatform(request);
      const query = parseQuery(
        z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        request.query,
      );
      return ok(reply, await container.platform.auditLog(principal, query.limit));
    });
  });
}
