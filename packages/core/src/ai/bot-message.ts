import type { Database } from '@smartchat/database';
import { ServerEvent, room } from '@smartchat/types';
import { toMessageDto, type EventPublisher } from '../realtime/events.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';

/**
 * One message from the assistant, written and delivered. Shared by the reply service (which
 * also records a turn) and the lifecycle service (which does not): the same row shape, the same
 * event, so the widget and the inbox render both the same way.
 */

export interface BotMessageInput {
  conversation: { id: string; accountId: string; propertyId: string; visitorId: string };
  assistantName: string;
  body: string;
  /** Extra metadata beside `source: 'ai'` and the name: sources, an offer, a kind, the badge. */
  metadata?: Record<string, unknown>;
  now: Date;
}

export async function postBotMessage(
  db: Database,
  events: EventPublisher,
  input: BotMessageInput,
): Promise<{ id: string }> {
  const persisted = await new ConversationRepository(db).insertMessage({
    accountId: input.conversation.accountId,
    propertyId: input.conversation.propertyId,
    conversationId: input.conversation.id,
    senderType: 'bot',
    type: 'text',
    body: input.body,
    metadata: { source: 'ai', senderName: input.assistantName, sources: [], ...input.metadata },
    now: input.now,
  });
  await events.publish({
    type: ServerEvent.MESSAGE_NEW,
    accountId: input.conversation.accountId,
    propertyId: input.conversation.propertyId,
    conversationId: input.conversation.id,
    visitorId: input.conversation.visitorId,
    payload: { message: toMessageDto(persisted.message), room: room.conversation(input.conversation.id) },
  });
  return { id: persisted.message.id };
}
