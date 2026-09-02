import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assignConversationSchema,
  banVisitorSchema,
  listConversationsSchema,
  listMessagesSchema,
  markReadSchema,
  sendMessageSchema,
  updateConversationSchema,
} from '@smartchat/validation';
import type { Conversation, Visitor } from '@smartchat/database';
import { Permission } from '@smartchat/types';
import { requirePermission } from '@smartchat/core';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export interface ConversationDto {
  id: string;
  propertyId: string;
  status: string;
  priority: string;
  channel: string;
  subject: string | null;
  tags: string[];
  assignedMemberId: string | null;
  lastMessageAt: string;
  startedAt: string;
  closedAt: string | null;
  agentUnreadCount: number;
  messageSeq: number;
  /**
   * What the pre-chat or offline form collected, as a list so the order the customer configured
   * is the order the agent reads. Values are whatever the visitor typed - claims, never
   * authorisation - and the keys were filtered against the property's own field list on write.
   */
  preChat: { key: string; value: string }[];
  visitor: {
    id: string;
    name: string | null;
    email: string | null;
    browser: string | null;
    os: string | null;
    deviceType: string;
    country: string | null;
    language: string | null;
    isReturning: boolean;
    /** So the panel can offer "ban" or "lift ban" rather than guessing which one applies. */
    isBanned: boolean;
    bannedUntil: string | null;
  };
}

/** Flatten the stored JSON, dropping anything that is not a plain string. */
function toPreChatEntries(value: unknown): { key: string; value: string }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === 'string' && entry.length > 0)
    .map(([key, entry]) => ({ key, value: entry as string }));
}

export function toConversationDto(row: Conversation & { visitor: Visitor }): ConversationDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    status: row.status,
    priority: row.priority,
    channel: row.channel,
    subject: row.subject,
    tags: row.tags,
    assignedMemberId: row.assignedMemberId,
    lastMessageAt: row.lastMessageAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    agentUnreadCount: row.agentUnreadCount,
    messageSeq: Number(row.messageSeq),
    preChat: toPreChatEntries(row.preChatData),
    visitor: {
      id: row.visitor.id,
      name: row.visitor.name,
      email: row.visitor.email,
      browser: row.visitor.browser,
      os: row.visitor.os,
      deviceType: row.visitor.deviceType,
      country: row.visitor.country,
      language: row.visitor.language,
      isReturning: row.visitor.visitCount > 1,
      // An expired ban reads as no ban, exactly as the service treats it - the panel must not
      // offer to lift something that has already lapsed.
      isBanned:
        row.visitor.isBanned &&
        (!row.visitor.bannedUntil || row.visitor.bannedUntil.getTime() > Date.now()),
      bannedUntil: row.visitor.bannedUntil?.toISOString() ?? null,
    },
  };
}

/**
 * The agent-facing conversation API.
 *
 * Every route here is also reachable over the socket. Both paths call the same service, so an HTTP
 * reply and a socket reply are the same operation — which is what makes the dashboard work whether
 * or not the socket is currently connected.
 */
export async function conversationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/conversations', async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseQuery(listConversationsSchema, request.query);
    const page = await container.conversations.list(tenant, query);
    return ok(
      reply,
      page.items.map(toConversationDto),
      page.meta as unknown as Record<string, unknown>,
    );
  });

  app.get('/conversations/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, toConversationDto(await container.conversations.get(tenant, id)));
  });

  app.get('/conversations/:id/messages', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const query = parseQuery(listMessagesSchema, request.query);
    const messages = await container.conversations.agentHistory(tenant, id, {
      beforeSeq: query.beforeSeq,
      limit: query.limit,
    });
    return ok(reply, messages);
  });

  app.post('/conversations/:id/messages', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(sendMessageSchema, request.body);
    const result = await container.conversations.sendAgentMessage(tenant, id, input);
    // 200 rather than 201 for a deduplicated retry: nothing was created this time.
    return result.created ? created(reply, result.message) : ok(reply, result.message);
  });

  app.patch('/conversations/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateConversationSchema, request.body);
    const conversation = await container.conversations.update(tenant, id, input);
    return ok(reply, { id: conversation.id, status: conversation.status });
  });

  app.post('/conversations/:id/assign', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(assignConversationSchema, request.body);
    const conversation = await container.conversations.assign(tenant, id, input.memberId);
    return ok(reply, { id: conversation.id, assignedMemberId: conversation.assignedMemberId });
  });

  app.post('/conversations/:id/read', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(markReadSchema, request.body);
    await container.conversations.markAgentRead(tenant, id, input.seq);
    return noContent(reply);
  });

  /**
   * Mint a single-use ticket for the realtime gateway.
   *
   * The browser cannot set a header on a WebSocket handshake, so a credential passed to the
   * gateway ends up in the query string — and therefore in proxy logs. A ticket obtained over this
   * authenticated request is worth 60 seconds and one connection.
   */
  app.post('/realtime/ticket', async (request, reply) => {
    const tenant = requireTenant(request);
    const ticket = await container.connectionTickets.issue({
      kind: 'agent',
      accountId: tenant.accountId,
      subjectId: tenant.memberId ?? '',
      ...(tenant.userId ? { userId: tenant.userId } : {}),
      ...(tenant.memberId ? { memberId: tenant.memberId } : {}),
      ...(tenant.actorName ? { actorName: tenant.actorName } : {}),
    });
    reply.header('cache-control', 'no-store');
    return ok(reply, { ...ticket, url: container.config.REALTIME_URL });
  });

  app.get('/presence/agents', async (request, reply) => {
    const tenant = requireTenant(request);
    return ok(reply, { agents: await container.presence.listAgents(tenant.accountId) });
  });

  app.get('/presence/visitors', async (request, reply) => {
    const tenant = requireTenant(request);
    /**
     * The permission the API scope claims to expand to.
     *
     * `VISITOR_VIEW` was granted by two roles and by the `conversations:read` API scope, and then
     * checked nowhere - so `INTEGRATIONS.md`'s promise that a scope "expands to real Permission
     * values, so a key ends up going through exactly the checks a member does" was not true for
     * this one. Property scoping below was doing all the work, which stops the wrong account but
     * not a member whose role deliberately excludes seeing who is on the site.
     */
    requirePermission(tenant, Permission.VISITOR_VIEW);
    const query = parseQuery(z.object({ propertyId: z.string().uuid() }), request.query);
    // Property scoping is enforced by resolving the property through the tenant-scoped service
    // first; a property id from another account simply does not exist here.
    await container.properties.get(tenant, query.propertyId);
    return ok(reply, { visitors: await container.presence.listVisitors(query.propertyId) });
  });

  /**
   * Ban a visitor.
   *
   * The enforcement has always been there - `authenticate` and `bootstrap` both refuse a banned
   * identity - but until now nothing could switch it on, which made it a control on paper. An
   * `until` makes the ban temporary; omitting it makes it permanent.
   */
  app.post('/visitors/:id/ban', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(z.object({ id: z.string().uuid() }), request.params);
    const input = parseBody(banVisitorSchema, request.body ?? {});
    const visitor = await container.visitors.ban(tenant, id, {
      until: input.until ? new Date(input.until) : null,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(reply, {
      id: visitor.id,
      isBanned: visitor.isBanned,
      bannedUntil: visitor.bannedUntil,
    });
  });

  app.delete('/visitors/:id/ban', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(z.object({ id: z.string().uuid() }), request.params);
    const visitor = await container.visitors.unban(tenant, id);
    return ok(reply, {
      id: visitor.id,
      isBanned: visitor.isBanned,
      bannedUntil: visitor.bannedUntil,
    });
  });
}
