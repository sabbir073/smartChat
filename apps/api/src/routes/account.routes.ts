import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { updateAccountSchema } from '@smartchat/validation';
import { AuditRepository, requirePermission } from '@smartchat/core';
import { Permission } from '@smartchat/types';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { ok } from '../lib/reply.js';
import { parseBody, parseQuery } from '../lib/validate.js';
import { toAccountDto, toMemberDto } from './dto.js';

export async function accountRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/account', { preHandler: app.authenticateTenant }, async (request, reply) => {
    const tenant = requireTenant(request);
    const [account, entitlements] = await Promise.all([
      container.accounts.get(tenant),
      container.entitlements.forAccount(tenant.accountId),
    ]);

    return ok(reply, {
      account: toAccountDto(account),
      plan: { code: entitlements.planCode, name: entitlements.planName },
      limits: entitlements.limits,
      features: entitlements.features,
      permissions: [...tenant.permissions],
      role: tenant.role,
    });
  });

  app.patch('/account', { preHandler: app.authenticateTenant }, async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(updateAccountSchema, request.body);
    const account = await container.accounts.update(tenant, input);
    return ok(reply, { account: toAccountDto(account) });
  });

  app.get('/account/members', { preHandler: app.authenticateTenant }, async (request, reply) => {
    const tenant = requireTenant(request);
    const members = await container.accounts.listMembers(tenant);
    return ok(reply, { members: members.map(toMemberDto) });
  });

  app.get('/account/audit-logs', { preHandler: app.authenticateTenant }, async (request, reply) => {
    const tenant = requireTenant(request);
    requirePermission(tenant, Permission.AUDIT_VIEW);

    const query = parseQuery(
      z.object({
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        action: z.string().max(80).optional(),
      }),
      request.query,
    );

    const page = await new AuditRepository(container.db).list(tenant, query);
    return ok(
      reply,
      page.items.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorType: entry.actorType,
        actorId: entry.actorId,
        actorLabel: entry.actorLabel,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ip: entry.ip,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      })),
      page.meta as unknown as Record<string, unknown>,
    );
  });
}
