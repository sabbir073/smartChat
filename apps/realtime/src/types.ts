import { RedisChannel, ServerEvent, room } from '@smartchat/types';

export { RedisChannel, ServerEvent, room };

/**
 * The shape the gateway needs from a published domain event.
 *
 * Deliberately structural rather than importing `DomainEvent` from core: everything crossing Redis
 * arrives as parsed JSON, so it is untrusted data that happens to look like the type. Treating it
 * as its own shape keeps that distinction visible.
 */
export interface DomainEventLike {
  type: ServerEvent;
  accountId: string;
  propertyId?: string;
  conversationId?: string;
  visitorId?: string;
  agentsOnly?: boolean;
  payload: Record<string, unknown>;
}
