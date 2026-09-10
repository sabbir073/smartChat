import type { Database } from '@smartchat/database';
import { ServerEvent } from '@smartchat/types';
import type { EventPublisher } from '../realtime/events.js';

/**
 * Who the visitor sees at the top of the chat window.
 *
 * The person the conversation is assigned to, with their picture; while nobody has it, the
 * account's owner - so the window always shows a real face from the business rather than a
 * generic one. It changes the moment a chat is assigned, transferred or handed back, and the
 * widget is told on the conversation's own channel (`conversation:presenter`).
 *
 * A visitor learns a first name and a picture and nothing else: no email, no id, no role.
 */

export interface Presenter {
  name: string;
  avatarUrl: string | null;
}

export class PresenterService {
  constructor(private readonly db: Database) {}

  /** The presenter for a conversation as assigned; the owner when it is not. */
  async forConversation(accountId: string, assignedMemberId: string | null): Promise<Presenter | null> {
    if (assignedMemberId) {
      const member = await this.db.accountMember.findFirst({
        where: { id: assignedMemberId, accountId, deletedAt: null },
        select: { displayName: true, user: { select: { name: true, avatarUrl: true } } },
      });
      if (member) return { name: member.displayName ?? member.user.name, avatarUrl: member.user.avatarUrl };
    }
    return this.owner(accountId);
  }

  /** The account's owner - the earliest active one, if there are several. */
  async owner(accountId: string): Promise<Presenter | null> {
    const owner = await this.db.accountMember.findFirst({
      where: { accountId, baseRole: 'owner', status: 'active', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { displayName: true, user: { select: { name: true, avatarUrl: true } } },
    });
    if (!owner) return null;
    return { name: owner.displayName ?? owner.user.name, avatarUrl: owner.user.avatarUrl };
  }

  /** Tell the visitor's window who is with them now. */
  async announce(
    events: EventPublisher,
    conversation: { id: string; accountId: string; propertyId: string; visitorId: string; assignedMemberId: string | null },
  ): Promise<void> {
    const presenter = await this.forConversation(conversation.accountId, conversation.assignedMemberId);
    await events.publish({
      type: ServerEvent.CONVERSATION_PRESENTER,
      accountId: conversation.accountId,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      visitorId: conversation.visitorId,
      payload: { conversationId: conversation.id, presenter },
    });
  }
}
