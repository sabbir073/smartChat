import type { Message } from '@smartchat/database';
import { RedisChannel, ServerEvent } from '@smartchat/types';
import type { RedisClient } from '../redis/client.js';

/**
 * Domain events, published to Redis and fanned out to sockets by the realtime gateway.
 *
 * The API and the gateway both publish here rather than one calling the other. That is what makes
 * the two paths identical: a message sent over HTTP reaches connected clients by exactly the same
 * route as one sent over the socket, so they cannot behave differently.
 */

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  clientMessageId: string | null;
  senderType: 'visitor' | 'agent' | 'system' | 'bot';
  senderId: string | null;
  senderName: string | null;
  type: 'text' | 'file' | 'image' | 'system' | 'note';
  body: string;
  createdAt: string;
  readAt: string | null;
}

export function toMessageDto(message: Message, senderName?: string | null): MessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    // BigInt does not survive JSON. Sequence numbers stay far below Number.MAX_SAFE_INTEGER
    // (9×10^15 messages in one conversation), so a number is safe and far easier to work with.
    seq: Number(message.seq),
    clientMessageId: message.clientMessageId,
    senderType: message.senderType,
    senderId: message.senderMemberId ?? message.senderVisitorId,
    senderName: senderName ?? null,
    type: message.type,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    readAt: message.readAt?.toISOString() ?? null,
  };
}

export interface DomainEvent {
  type: ServerEvent;
  accountId: string;
  propertyId: string;
  conversationId?: string;
  visitorId?: string;
  /**
   * When true the event carries content a visitor must never see (an internal note, agent-only
   * metadata) and is delivered to agent rooms only.
   */
  agentsOnly?: boolean;
  payload: Record<string, unknown>;
  /** Correlates the event back to the request that produced it. */
  requestId?: string;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

/** Publishes to Redis so every gateway instance can deliver to its own connected sockets. */
export class RedisEventPublisher implements EventPublisher {
  constructor(
    private readonly redis: RedisClient,
    private readonly onError?: (error: Error) => void,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    try {
      await this.redis.publish(RedisChannel.CONVERSATION_EVENTS, JSON.stringify(event));
    } catch (error) {
      // A failed broadcast must never fail the write that produced it: the message is already
      // durable in Postgres, and clients recover it on their next sync.
      this.onError?.(error as Error);
    }
  }
}

/** Collects events instead of publishing them. Used in tests. */
export class RecordingEventPublisher implements EventPublisher {
  readonly events: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }
}

export { ServerEvent };
