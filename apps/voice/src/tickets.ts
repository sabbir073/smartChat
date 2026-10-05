import { VisitorRepository, type TicketService } from '@smartchat/core';
import type { Database } from '@smartchat/database';

/**
 * A ticket raised from a call.
 *
 * The brain could not answer and the caller said yes: a ticket goes to the team by the same
 * path an offline message takes, with the last few things the caller asked as its body, so the
 * person who picks it up reads the question rather than "see call". When the address came from
 * the chat box rather than the visitor's record, it is written onto the visitor first - the one
 * place an email is ever attached to a browser - so the next call does not have to ask again.
 */

export interface CallTicketInput {
  accountId: string;
  propertyId: string;
  conversationId: string;
  visitorId: string;
  visitorName: string | null;
  email: string;
  /** The address was just typed in the chat: record it on the visitor before using it. */
  identify: boolean;
  /** The caller's questions, oldest first; the last few of the call. */
  questions: string[];
}

export function ticketBody(questions: string[]): string {
  const asked = questions.map((question) => question.trim()).filter(Boolean);
  const lines = ['Call transcript request'];
  if (asked.length > 0) {
    lines.push('');
    lines.push(...asked.map((question) => `- ${question}`));
  }
  lines.push('');
  lines.push('Requested by phone.');
  return lines.join('\n');
}

export async function createCallTicket(
  deps: { db: Database; tickets: TicketService },
  input: CallTicketInput,
): Promise<{ number: number } | null> {
  if (input.identify) {
    await new VisitorRepository(deps.db).identify(input.accountId, input.visitorId, {
      email: input.email,
    });
  }
  const ticket = await deps.tickets.openFromOfflineMessage({
    accountId: input.accountId,
    propertyId: input.propertyId,
    conversationId: input.conversationId,
    visitorId: input.visitorId,
    body: ticketBody(input.questions),
    requesterEmail: input.email,
    requesterName: input.visitorName,
  });
  return ticket ? { number: ticket.number } : null;
}
