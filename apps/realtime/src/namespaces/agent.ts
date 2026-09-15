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
import { agentAvailabilityReader } from '@smartchat/core';
import { ackError, ackOk, parsePayload, respond, type AckCallback } from '../lib/ack.js';

interface AgentSocketData {
  context: TenantContext;
  propertyIds: string[];
  /** How this member is shown to their colleagues when they have a conversation open. */
  identity: { memberId: string; name: string; avatarUrl: string | null };
  /** The conversation this socket currently has open, if any. */
  viewing: { conversationId: string; propertyId: string } | null;
  /**
   * What the agent last *asked* for, recorded the moment the event arrives rather than when its
   * database work finishes. Two clicks in a row, or a click and a Back, race otherwise: the
   * handlers are async and nothing makes them finish in the order they started.
   */
  intent: { conversationId: string; at: number } | null;
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
  const { logger, presence, conversations, connectionTickets, db } = container;
  /**
   * "Is anybody available" comes from the persisted choice on the membership rows, the same source
   * the API's bootstrap reads. Two answers to one question, computed differently in two processes,
   * is how a widget ends up disagreeing with the dashboard about who is online.
   */
  const hasAvailableAgent = agentAvailabilityReader(db);

  namespace.use(async (socket, next) => {
    try {
      const ticket = String(socket.handshake.auth?.['ticket'] ?? '');
      const claims = await connectionTickets.redeem(ticket);

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
        include: {
          role: true,
          properties: { select: { propertyId: true } },
          // Shown to colleagues in the inbox as "who is on this chat". A display name set on the
          // membership wins over the account name, the same rule the visitor's window follows.
          user: { select: { name: true, avatarUrl: true } },
        },
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
      data.identity = {
        memberId: membership.id,
        name: membership.displayName ?? membership.user.name,
        avatarUrl: membership.user.avatarUrl,
      };
      data.viewing = null;
      data.intent = null;
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
    /**
     * Starts as offline and is corrected from the database below.
     *
     * It used to start as `'online'`, which meant opening the dashboard silently published you as
     * available regardless of the status you had chosen — connecting a socket is not a decision to
     * be available. Offline is the safe assumption for the moment before we know: it makes a
     * visitor wait a beat for the real answer rather than promising them somebody who is not
     * there.
     */
    let availability: 'online' | 'away' | 'offline' = 'offline';

    /**
     * Adopt the status this member actually chose, then say so.
     *
     * Without this the socket's idea of availability is whatever the last `presence:set` on *this*
     * connection said, so a reconnect - a laptop waking, a deploy, a flaky train - reset an agent
     * to the default and the widget followed it.
     */
    const adoptPersistedAvailability = async (): Promise<void> => {
      const member = await db.accountMember
        .findUnique({ where: { id: memberId }, select: { availability: true } })
        .catch(() => null);
      if (member) availability = member.availability;
      await touch();
      await announceAvailability();
    };

    const touch = () =>
      presence
        .setAgentOnline(context.accountId, memberId, availability, Date.now())
        .catch((error: unknown) => logger.error({ err: error }, 'presence write failed'));

    /**
     * Tell the account's visitors whether anybody is there.
     *
     * Recomputed from presence rather than inferred from this one member's status: "somebody is
     * available" is a property of the whole team, and this socket only knows about itself. It is
     * what decides whether a widget offers a live chat or an offline form, so it has to be true.
     */
    const announceAvailability = async (): Promise<void> => {
      try {
        const available = await hasAvailableAgent(context.accountId);
        namespace.server
          .of('/visitor')
          .to(room.account(context.accountId))
          .emit(ServerEvent.AGENTS_AVAILABLE, { available });
      } catch (error) {
        logger.error({ err: error }, 'could not announce availability');
      }
    };

    // --- who has this conversation open -------------------------------------

    /**
     * Ticks once per open, so two requests made inside the same millisecond still differ. The
     * value itself means nothing; only "is this still the one the agent asked for" does.
     */
    let viewSequence = 0;

    /**
     * Tell the property's inbox who is on a conversation.
     *
     * The list is read back from Redis rather than kept in memory, because the answer spans every
     * gateway instance and every tab: two people on two machines are two sockets that know
     * nothing about each other. Deduplicated by member, so one person with the same chat open in
     * two tabs is named once.
     *
     * It goes to the property's room, not the account's: an agent restricted to one website has
     * no business being told that a conversation id they cannot open is being read.
     */
    const announceViewers = async (target: { conversationId: string; propertyId: string }): Promise<void> => {
      try {
        const all = await presence.listViewers(context.accountId);
        const byMember = new Map<string, { memberId: string; name: string; avatarUrl: string | null }>();
        for (const viewer of all) {
          if (viewer.conversationId !== target.conversationId) continue;
          // One entry per person, whatever the number of tabs they have it open in.
          if (!byMember.has(viewer.memberId)) {
            byMember.set(viewer.memberId, { memberId: viewer.memberId, name: viewer.name, avatarUrl: viewer.avatarUrl });
          }
        }
        const viewers = [...byMember.values()];
        namespace.to(room.property(target.propertyId)).emit(ServerEvent.CONVERSATION_VIEWERS, {
          conversationId: target.conversationId,
          viewers,
        });
      } catch (error) {
        logger.error({ err: error }, 'could not announce conversation viewers');
      }
    };

    /**
     * Open a conversation as a viewer, leaving whichever one was open before.
     *
     * Both conversations are announced: the one being left has one fewer name on it, and saying
     * so is the entire point - a name that stays after the person has moved on is worse than no
     * name at all.
     */
    const startViewing = async (conversationId: string, propertyId: string, asked: number): Promise<void> => {
      const data = (socket as AgentSocket).data;
      // The agent has moved on - to another conversation, or back to the list - while this open
      // was still loading. Whatever they asked for last is the truth; this answer is stale.
      if (data.intent?.at !== asked) return;
      const previous = data.viewing;
      if (previous?.conversationId === conversationId) return;
      data.viewing = { conversationId, propertyId };
      await presence
        .setViewer(context.accountId, socket.id, { conversationId, propertyId, ...data.identity })
        .catch((error: unknown) => logger.error({ err: error }, 'viewer write failed'));
      if (previous) await announceViewers(previous);
      await announceViewers({ conversationId, propertyId });
    };

    const stopViewing = async (conversationId?: string): Promise<void> => {
      const data = (socket as AgentSocket).data;
      // Cancel any open still in flight first. Without this, closing a conversation whose history
      // has not arrived yet leaves the agent advertised on it for as long as their socket lives:
      // the close finds nothing to clear, and the open writes the entry a moment later.
      if (!conversationId || data.intent?.conversationId === conversationId) data.intent = null;
      const previous = data.viewing;
      if (!previous) return;
      if (conversationId && previous.conversationId !== conversationId) return;
      data.viewing = null;
      await presence
        .clearViewer(context.accountId, socket.id)
        .catch((error: unknown) => logger.error({ err: error }, 'viewer clear failed'));
      await announceViewers(previous);
    };

    /**
     * The conversation's website, checked against this agent's scope.
     *
     * Returns null when the conversation is not theirs to see, so a viewer entry can never be
     * written for a conversation the caller could not open.
     */
    const propertyOf = async (conversationId: string): Promise<string | null> => {
      const conversation = await db.conversation.findFirst({
        where: { id: conversationId, accountId: context.accountId },
        select: { propertyId: true },
      });
      if (!conversation) return null;
      const allowed = (socket as AgentSocket).data.propertyIds;
      if (allowed.length > 0 && !allowed.includes(conversation.propertyId)) return null;
      return conversation.propertyId;
    };

    /**
     * The heartbeat keeps both kinds of presence alive, and repeats the viewer list.
     *
     * Repeating it is what lets a dashboard forget a viewer whose browser died: the entry expires
     * from Redis on its own, and the next heartbeat from anybody else publishes a list without
     * it. Without the repeat, the last list ever sent would be the one that stayed on screen.
     */
    heartbeat = setInterval(() => {
      void touch();
      const viewing = (socket as AgentSocket).data.viewing;
      if (!viewing) return;
      void presence
        .touchViewer(context.accountId, socket.id)
        .catch((error: unknown) => logger.error({ err: error }, 'viewer refresh failed'));
      void announceViewers(viewing);
    }, PRESENCE_HEARTBEAT_SECONDS * 1000);

    // Reads the chosen status, writes presence, and announces - in that order, so nothing is
    // published from the placeholder value above.
    void adoptPersistedAvailability().then(() => {
      namespace.to(room.account(context.accountId)).emit(ServerEvent.PRESENCE_AGENT, {
        memberId,
        status: availability,
        online: availability !== 'offline',
      });
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

          /**
           * Property rooms are filtered twice, and the first filter is the one that matters.
           *
           * The membership's own scope only narrows *within* the account: an unrestricted member
           * has an empty scope list, which used to mean "join whatever you asked for". A property
           * id is not a secret - it is in a dashboard URL - so that let a member of one account
           * join a room belonging to another and receive its conversation events, its visitor
           * presence and, since this batch, the names and pictures of its team. So the ids are
           * checked against the account first, and the member's scope second.
           */
          const requested = input.propertyIds ?? [];
          const ours =
            requested.length === 0
              ? []
              : (
                  await db.property.findMany({
                    where: { accountId: context.accountId, id: { in: requested }, deletedAt: null },
                    select: { id: true },
                  })
                ).map((property) => property.id);
          const allowed = (socket as AgentSocket).data.propertyIds;
          const target = allowed.length > 0 ? ours.filter((id) => allowed.includes(id)) : ours;

          for (const propertyId of target) {
            await socket.join(room.property(propertyId));
          }

          const visitors = await Promise.all(
            target.map(async (propertyId) => ({
              propertyId,
              visitors: await presence.listVisitors(propertyId),
            })),
          );

          /**
           * Who is on what, as of this moment.
           *
           * Without a snapshot the inbox would only learn about a colleague when they next opened
           * or left a conversation, so an agent who arrived second would see an empty list for up
           * to a heartbeat and think nobody was there.
           */
          const watching = new Set(target);
          const seen = new Set<string>();
          const byConversation = new Map<string, Array<{ memberId: string; name: string; avatarUrl: string | null }>>();
          for (const viewer of await presence.listViewers(context.accountId)) {
            if (!watching.has(viewer.propertyId)) continue;
            const key = `${viewer.conversationId}:${viewer.memberId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = byConversation.get(viewer.conversationId) ?? [];
            list.push({ memberId: viewer.memberId, name: viewer.name, avatarUrl: viewer.avatarUrl });
            byConversation.set(viewer.conversationId, list);
          }
          const viewers = [...byConversation.entries()].map(([conversationId, list]) => ({
            conversationId,
            viewers: list,
          }));

          respond(callback, ackOk({ subscribed: target, presence: visitors, viewers }));
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
          // Claimed here, before the first await, so that whichever request was made last wins
          // however the database chooses to answer them.
          const asked = Date.now() + viewSequence++;
          (socket as AgentSocket).data.intent = { conversationId: input.conversationId, at: asked };
          const messages = await conversations.agentHistory(context, input.conversationId, {
            beforeSeq: input.beforeSeq,
            limit: input.limit,
          });
          await socket.join(room.conversation(input.conversationId));
          // After the history call, which is what authorises the read: a viewer entry is never
          // written for a conversation this agent could not have opened.
          const propertyId = await propertyOf(input.conversationId);
          if (propertyId) await startViewing(input.conversationId, propertyId, asked);
          respond(callback, ackOk({ messages }));
        } catch (error) {
          respond(callback, ackError(error));
        }
      },
    );

    socket.on(AgentClientEvent.CONVERSATION_CLOSE_VIEW, (payload: unknown) => {
      const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(payload);
      if (!parsed.success) return;
      void socket.leave(room.conversation(parsed.data.conversationId));
      void stopViewing(parsed.data.conversationId);
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
        await announceAvailability();
      })();
    });

    socket.on('disconnect', (reason) => {
      if (heartbeat) clearInterval(heartbeat);
      // The tab is gone, so whatever it had open is no longer being read by anybody in it.
      void stopViewing();
      void presence.setAgentOffline(context.accountId, memberId).catch(() => undefined);
      namespace.to(room.account(context.accountId)).emit(ServerEvent.PRESENCE_AGENT, {
        memberId,
        status: 'offline',
        online: false,
      });
      // The presence key is removed above, so this recomputation sees the team without this
      // member - which is the whole point of announcing after leaving rather than before.
      void announceAvailability();
      logger.debug({ memberId, reason }, 'agent disconnected');
    });
  });
}

export { ErrorCode };
