import type { Namespace, Socket } from 'socket.io';
import {
  ActorType,
  AgentClientEvent,
  AppError,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorCode,
  PRESENCE_HEARTBEAT_SECONDS,
  Permission,
  ServerEvent,
  room,
  type MemberRole,
  type TenantContext,
} from '@smartchat/types';
import {
  listMessagesSchema,
  markReadSchema,
  sendMessageSchema,
  syncSinceSchema,
} from '@smartchat/validation';
import { z } from 'zod';
import type { RealtimeContainer } from '../container.js';
import { ackError, ackOk, parsePayload, respond, type AckCallback } from '../lib/ack.js';

interface AgentSocketData {
  context: TenantContext;
  propertyIds: string[];
}

type AgentSocket = Socket & { data: AgentSocketData };

/**
 * The agent namespace.
 *
 * The ticket carries the account and membership; permissions are re-read from the database at
 * connection time rather than trusted from the ticket, so a role change takes effect on the next
 * connection instead of whenever a token happens to expire.
 */
export function registerAgentNamespace(namespace: Namespace, container: RealtimeContainer): void {
  const { logger, presence, conversations, tickets, db } = container;

  namespace.use(async (socket, next) => {
    try {
      const ticket = String(socket.handshake.auth?.['ticket'] ?? '');
      const claims = await tickets.redeem(ticket);

      if (!claims || claims.kind !== 'agent' || !claims.memberId) {
        next(new Error('unauthorised'));
        return;
      }

      const membership = await db.accountMember.findFirst({
        where: {
          id: claims.memberId,
          accountId: claims.accountId,
          deletedAt: null,
          status: 'active',
          account: { deletedAt: null, status: 'active' },
        },
        include: { role: true, properties: { select: { propertyId: true } } },
      });

      // A membership that has been disabled, removed, or whose account was suspended since the
      // ticket was issued must not connect - which is the whole reason this is re-checked here.
      if (!membership) {
        next(new Error('unauthorised'));
        return;
      }

      const permissions = new Set(
        (membership.role?.permissions.length
          ? membership.role.permissions
          : (DEFAULT_ROLE_PERMISSIONS[membership.baseRole as MemberRole] ?? [])
        ).filter((entry): entry is Permission =>
          (Object.values(Permission) as string[]).includes(entry),
        ),
      );

      const context: TenantContext = {
        accountId: membership.accountId,
        userId: membership.userId,
        memberId: membership.id,
        actorType: ActorType.USER,
        role: membership.baseRole as MemberRole,
        permissions,
        requestId: socket.id,
      };
      if (claims.actorName) (context as { actorName?: string }).actorName = claims.actorName;
      if (membership.restrictedToProperties) {
        const ids = membership.properties.map((entry) => entry.propertyId);
        (context as { propertyIds?: ReadonlySet<string> }).propertyIds = new Set(
          ids.length > 0 ? ids : ['__none__'],
        );
      }

      const data = (socket as AgentSocket).data;
      data.context = context;
      data.propertyIds = membership.restrictedToProperties
        ? membership.properties.map((entry) => entry.propertyId)
        : [];
      next();
    } catch (error) {
      logger.error({ err: error }, 'agent handshake failed');
      next(new Error('unauthorised'));
    }
  });

  namespace.on('connection', (socket) => {
    const { context } = (socket as AgentSocket).data;
    const memberId = context.memberId as string;

    void socket.join(room.account(context.accountId));
    void socket.join(room.agent(memberId));

    let heartbeat: NodeJS.Timeout | null = null;
    let availability: 'online' | 'away' | 'offline' = 'online';

    const touch = () =>
      presence
        .setAgentOnline(context.accountId, memberId, availability, Date.now())
        .catch((error: unknown) => logger.error({ err: error }, 'presence write failed'));

    void touch();
    heartbeat = setInterval(touch, PRESENCE_HEARTBEAT_SECONDS * 1000);

    namespace.to(room.account(context.accountId)).emit(ServerEvent.PRESENCE_AGENT, {
      memberId,
      status: availability,
      online: true,
    });

    logger.debug({ memberId, socketId: socket.id }, 'agent connected');

    // --- inbox subscription -------------------------------------------------
    socket.on(
      AgentClientEvent.INBOX_SUBSCRIBE,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          const input = parsePayload(
            z.object({ propertyIds: z.array(z.string().uuid()).max(200).optional() }),
            payload,
          );

          // Property rooms are filtered through the membership's own scope, so asking to watch a
          // property this agent is not assigned to simply does not join that room.
          const allowed = (socket as AgentSocket).data.propertyIds;
          const requested = input.propertyIds ?? [];
          const target =
            allowed.length > 0 ? requested.filter((id) => allowed.includes(id)) : requested;

          for (const propertyId of target) {
            await socket.join(room.property(propertyId));
          }

          const visitors = await Promise.all(
            target.map(async (propertyId) => ({
              propertyId,
              visitors: await presence.listVisitors(propertyId),
            })),
          );

          respond(callback, ackOk({ subscribed: target, presence: visitors }));
        } catch (error) {
          respond(callback, ackError(error));
        }
      },
    );

    // --- open a conversation ------------------------------------------------
    socket.on(
      AgentClientEvent.CONVERSATION_OPEN,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          const input = parsePayload(
            listMessagesSchema.extend({ conversationId: z.string().uuid() }),
            payload,
          );
          const messages = await conversations.agentHistory(context, input.conversationId, {
            beforeSeq: input.beforeSeq,
            limit: input.limit,
          });
          await socket.join(room.conversation(input.conversationId));
          respond(callback, ackOk({ messages }));
        } catch (error) {
          respond(callback, ackError(error));
        }
      },
    );

    socket.on(AgentClientEvent.CONVERSATION_CLOSE_VIEW, (payload: unknown) => {
      const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(payload);
      if (parsed.success) void socket.leave(room.conversation(parsed.data.conversationId));
    });

    // --- reply and note -----------------------------------------------------
    const send = (type: 'text' | 'note') =>
      async function handler(payload: unknown, callback: AckCallback<unknown>) {
        try {
          const input = parsePayload(
            sendMessageSchema.extend({ conversationId: z.string().uuid() }),
            payload,
          );
          const result = await conversations.sendAgentMessage(context, input.conversationId, {
            clientMessageId: input.clientMessageId,
            body: input.body,
            type,
          });
          await socket.join(room.conversation(input.conversationId));
          respond(callback, ackOk({ message: result.message, deduplicated: !result.created }));
        } catch (error) {
          if (!(error instanceof AppError) || error.status >= 500) {
            logger.error({ err: error, memberId }, 'agent message failed');
          }
          respond(callback, ackError(error));
        }
      };

    socket.on(AgentClientEvent.MESSAGE_SEND, send('text'));
    socket.on(AgentClientEvent.NOTE_ADD, send('note'));

    // --- resync -------------------------------------------------------------
    socket.on(
      AgentClientEvent.SYNC_SINCE,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          const input = parsePayload(syncSinceSchema, payload);
          const messages = await conversations.agentSync(
            context,
            input.conversationId,
            input.lastSeq,
          );
          await socket.join(room.conversation(input.conversationId));
          respond(callback, ackOk({ messages }));
        } catch (error) {
          respond(callback, ackError(error));
        }
      },
    );

    // --- typing -------------------------------------------------------------
    const typing = (isTyping: boolean) => (payload: unknown) => {
      void (async () => {
        const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(payload);
        if (!parsed.success) return;
        const { conversationId } = parsed.data;

        if (isTyping) await presence.setTyping(conversationId, memberId);
        else await presence.clearTyping(conversationId, memberId);

        const event = {
          conversationId,
          actorType: 'agent',
          actorId: memberId,
          actorName: context.actorName ?? null,
          typing: isTyping,
        };
        socket.to(room.conversation(conversationId)).emit(ServerEvent.TYPING, event);
        namespace.server
          .of('/visitor')
          .to(room.conversation(conversationId))
          .emit(ServerEvent.TYPING, event);
      })();
    };

    socket.on(AgentClientEvent.TYPING_START, typing(true));
    socket.on(AgentClientEvent.TYPING_STOP, typing(false));

    // --- read receipts ------------------------------------------------------
    socket.on(AgentClientEvent.MESSAGE_READ, (payload: unknown) => {
      void (async () => {
        try {
          const input = parsePayload(
            markReadSchema.extend({ conversationId: z.string().uuid() }),
            payload,
          );
          await conversations.markAgentRead(context, input.conversationId, input.seq);
        } catch (error) {
          if (!(error instanceof AppError)) {
            logger.error({ err: error }, 'failed to record read position');
          }
        }
      })();
    });

    // --- availability -------------------------------------------------------
    socket.on(AgentClientEvent.PRESENCE_SET, (payload: unknown) => {
      void (async () => {
        const parsed = z
          .object({ status: z.enum(['online', 'away', 'offline']) })
          .safeParse(payload);
        if (!parsed.success) return;

        availability = parsed.data.status;
        await touch();
        // Persisted as well as broadcast: availability is a deliberate choice, not ephemeral
        // presence, so it must survive a reconnect.
        await db.accountMember
          .updateMany({ where: { id: memberId }, data: { availability } })
          .catch(() => undefined);

        namespace.to(room.account(context.accountId)).emit(ServerEvent.PRESENCE_AGENT, {
          memberId,
          status: availability,
          online: availability !== 'offline',
        });
      })();
    });

    socket.on('disconnect', (reason) => {
      if (heartbeat) clearInterval(heartbeat);
      void presence.setAgentOffline(context.accountId, memberId).catch(() => undefined);
      namespace.to(room.account(context.accountId)).emit(ServerEvent.PRESENCE_AGENT, {
        memberId,
        status: 'offline',
        online: false,
      });
      logger.debug({ memberId, reason }, 'agent disconnected');
    });
  });
}

export { ErrorCode };
