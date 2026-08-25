import type { Namespace, Socket } from 'socket.io';
import {
  PRESENCE_HEARTBEAT_SECONDS,
  ServerEvent,
  VisitorClientEvent,
  room,
} from '@smartchat/types';
import { AppError, ErrorCode } from '@smartchat/types';
import {
  listMessagesSchema,
  sendMessageSchema,
  startConversationSchema,
  syncSinceSchema,
  widgetPageViewSchema,
} from '@smartchat/validation';
import { sanitiseUrl, type VisitorIdentity } from '@smartchat/core';
import { z } from 'zod';
import type { RealtimeContainer } from '../container.js';
import { SocketAbuseGuard } from '../lib/abuse.js';
import { ackError, ackOk, parsePayload, respond, type AckCallback } from '../lib/ack.js';

interface VisitorSocketData {
  identity: VisitorIdentity;
}

type VisitorSocket = Socket & { data: VisitorSocketData };

/**
 * The visitor namespace.
 *
 * Authenticated by a single-use ticket in the handshake, never by a long-lived credential in a
 * query string. Every room this socket joins is derived from the identity the ticket carried, so a
 * client cannot ask to listen to a conversation that is not theirs.
 */
export function registerVisitorNamespace(namespace: Namespace, container: RealtimeContainer): void {
  const { logger, presence, conversations, tickets } = container;
  const guard = new SocketAbuseGuard(container.redis, (error) =>
    logger.error({ err: error }, 'rate limiter unavailable'),
  );

  namespace.use(async (socket, next) => {
    try {
      const ticket = String(socket.handshake.auth?.['ticket'] ?? '');
      const claims = await tickets.redeem(ticket);

      if (!claims || claims.kind !== 'visitor' || !claims.propertyId) {
        // Deliberately uniform: a used, expired, forged or wrong-kind ticket all look identical.
        next(new Error('unauthorised'));
        return;
      }

      (socket as VisitorSocket).data.identity = {
        accountId: claims.accountId,
        propertyId: claims.propertyId,
        visitorId: claims.subjectId,
        sessionId: claims.sessionId ?? '',
        visitorName: claims.actorName ?? null,
      };
      next();
    } catch (error) {
      logger.error({ err: error }, 'visitor handshake failed');
      next(new Error('unauthorised'));
    }
  });

  namespace.on('connection', (socket) => {
    const { identity } = (socket as VisitorSocket).data;

    // Rooms come from the authenticated identity, never from the client.
    void socket.join(room.visitor(identity.visitorId));

    let heartbeat: NodeJS.Timeout | null = null;
    let currentPage: { url: string | null; title: string | null } = { url: null, title: null };

    const touchPresence = () =>
      presence
        .setVisitorOnline(identity.propertyId, identity.visitorId, currentPage, Date.now())
        .catch((error: unknown) => logger.error({ err: error }, 'presence write failed'));

    void touchPresence();
    heartbeat = setInterval(touchPresence, PRESENCE_HEARTBEAT_SECONDS * 1000);

    logger.debug({ visitorId: identity.visitorId, socketId: socket.id }, 'visitor connected');

    // --- start or continue a conversation -----------------------------------
    socket.on(
      VisitorClientEvent.CONVERSATION_START,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          if (!(await guard.allowMessage(socket.id, identity.visitorId, identity.propertyId))) {
            throw new AppError(ErrorCode.RATE_LIMITED);
          }
          const input = parsePayload(startConversationSchema, payload);
          const result = await conversations.startOrContinue(identity, input);

          await socket.join(room.conversation(result.conversation.id));

          respond(
            callback,
            ackOk({
              conversationId: result.conversation.id,
              message: result.message,
              isNew: result.isNew,
            }),
          );
        } catch (error) {
          handleFailure(socket, guard, logger, error);
          respond(callback, ackError(error));
        }
      },
    );

    // --- send ---------------------------------------------------------------
    socket.on(
      VisitorClientEvent.MESSAGE_SEND,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          if (!(await guard.allowMessage(socket.id, identity.visitorId, identity.propertyId))) {
            throw new AppError(ErrorCode.RATE_LIMITED);
          }
          const input = parsePayload(
            sendMessageSchema.extend({ conversationId: z.string().uuid() }),
            payload,
          );

          const result = await conversations.sendVisitorMessage(identity, input.conversationId, {
            clientMessageId: input.clientMessageId,
            body: input.body,
            type: 'text',
          });

          await socket.join(room.conversation(input.conversationId));
          // The acknowledgement is only sent once the message is committed, which is what makes
          // "sent" on the visitor's screen mean "durable" rather than "left this machine".
          respond(callback, ackOk({ message: result.message, deduplicated: !result.created }));
        } catch (error) {
          handleFailure(socket, guard, logger, error);
          respond(callback, ackError(error));
        }
      },
    );

    // --- end the chat -------------------------------------------------------
    socket.on(
      VisitorClientEvent.CONVERSATION_CLOSE,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          const input = parsePayload(z.object({ conversationId: z.string().uuid() }), payload);
          const result = await conversations.closeByVisitor(identity, input.conversationId);
          respond(
            callback,
            ackOk({ conversationId: input.conversationId, alreadyClosed: result.alreadyClosed }),
          );
        } catch (error) {
          handleFailure(socket, guard, logger, error);
          respond(callback, ackError(error));
        }
      },
    );

    // --- history and resync -------------------------------------------------
    socket.on(
      VisitorClientEvent.SYNC_SINCE,
      async (payload: unknown, callback: AckCallback<unknown>) => {
        try {
          const input = parsePayload(syncSinceSchema, payload);
          const messages = await conversations.visitorSync(
            identity,
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

    socket.on('conversation:history', async (payload: unknown, callback: AckCallback<unknown>) => {
      try {
        const input = parsePayload(
          listMessagesSchema.extend({ conversationId: z.string().uuid() }),
          payload,
        );
        const messages = await conversations.visitorHistory(identity, input.conversationId, {
          beforeSeq: input.beforeSeq,
          limit: input.limit,
        });
        await socket.join(room.conversation(input.conversationId));
        respond(callback, ackOk({ messages }));
      } catch (error) {
        respond(callback, ackError(error));
      }
    });

    /** Lets a returning visitor pick up where they left off without starting a new thread. */
    socket.on('conversation:resume', async (_payload: unknown, callback: AckCallback<unknown>) => {
      try {
        const conversation = await conversations.findVisitorConversation(identity);
        if (!conversation) {
          respond(callback, ackOk({ conversation: null, messages: [] }));
          return;
        }
        const messages = await conversations.visitorHistory(identity, conversation.id, {
          limit: 50,
        });
        await socket.join(room.conversation(conversation.id));
        respond(
          callback,
          ackOk({
            conversation: {
              id: conversation.id,
              status: conversation.status,
              lastSeq: Number(conversation.messageSeq),
            },
            messages,
          }),
        );
      } catch (error) {
        respond(callback, ackError(error));
      }
    });

    // --- typing -------------------------------------------------------------
    socket.on(VisitorClientEvent.TYPING_START, (payload: unknown) => {
      void (async () => {
        try {
          const input = parsePayload(z.object({ conversationId: z.string().uuid() }), payload);
          await presence.setTyping(input.conversationId, identity.visitorId);
          // Broadcast to everyone else in the room; the sender does not need to be told.
          socket.to(room.conversation(input.conversationId)).emit(ServerEvent.TYPING, {
            conversationId: input.conversationId,
            actorType: 'visitor',
            actorId: identity.visitorId,
            typing: true,
          });
        } catch {
          guard.strike(socket.id);
        }
      })();
    });

    socket.on(VisitorClientEvent.TYPING_STOP, (payload: unknown) => {
      void (async () => {
        try {
          const input = parsePayload(z.object({ conversationId: z.string().uuid() }), payload);
          await presence.clearTyping(input.conversationId, identity.visitorId);
          socket.to(room.conversation(input.conversationId)).emit(ServerEvent.TYPING, {
            conversationId: input.conversationId,
            actorType: 'visitor',
            actorId: identity.visitorId,
            typing: false,
          });
        } catch {
          guard.strike(socket.id);
        }
      })();
    });

    // --- read receipts ------------------------------------------------------
    socket.on(VisitorClientEvent.MESSAGE_READ, (payload: unknown) => {
      void (async () => {
        try {
          const input = parsePayload(z.object({ conversationId: z.string().uuid() }), payload);
          await conversations.markVisitorRead(identity, input.conversationId);
        } catch {
          guard.strike(socket.id);
        }
      })();
    });

    // --- page tracking ------------------------------------------------------
    socket.on(VisitorClientEvent.PAGE_VIEW, (payload: unknown) => {
      void (async () => {
        try {
          const input = parsePayload(widgetPageViewSchema, payload);
          currentPage = { url: sanitiseUrl(input.url), title: input.title ?? null };
          await touchPresence();
          // Agents watching this property see the visitor move around the site live.
          namespace.server
            .of('/agent')
            .to(room.property(identity.propertyId))
            .emit(ServerEvent.PRESENCE_VISITOR, {
              visitorId: identity.visitorId,
              propertyId: identity.propertyId,
              online: true,
              ...currentPage,
            });
        } catch {
          guard.strike(socket.id);
        }
      })();
    });

    socket.on('disconnect', (reason) => {
      if (heartbeat) clearInterval(heartbeat);
      guard.forget(socket.id);
      void presence
        .setVisitorOffline(identity.propertyId, identity.visitorId)
        .catch(() => undefined);

      namespace.server
        .of('/agent')
        .to(room.property(identity.propertyId))
        .emit(ServerEvent.PRESENCE_VISITOR, {
          visitorId: identity.visitorId,
          propertyId: identity.propertyId,
          online: false,
        });

      logger.debug({ visitorId: identity.visitorId, reason }, 'visitor disconnected');
    });
  });
}

/**
 * A client that keeps sending things we refuse is disconnected.
 *
 * Throttling alone is not enough: an attacker simply holds the connection open and keeps trying,
 * which costs them nothing and costs us a socket.
 */
function handleFailure(
  socket: Socket,
  guard: SocketAbuseGuard,
  logger: RealtimeContainer['logger'],
  error: unknown,
): void {
  const strikes = guard.strike(socket.id);
  if (guard.shouldDisconnect(socket.id)) {
    logger.warn({ socketId: socket.id, strikes }, 'disconnecting abusive socket');
    socket.disconnect(true);
    return;
  }
  if (!(error instanceof AppError) || error.status >= 500) {
    logger.error({ err: error, socketId: socket.id }, 'visitor socket handler failed');
  }
}
