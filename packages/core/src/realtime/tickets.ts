import { REALTIME_TICKET_TTL_SECONDS, presenceKey } from '@smartchat/types';
import { generateToken, hashToken } from '../crypto/tokens.js';
import type { RedisClient } from '../redis/client.js';

/**
 * Single-use connection tickets.
 *
 * A WebSocket handshake cannot carry a custom header in the browser, so credentials end up in the
 * query string - where they land in proxy logs, browser history and referrers. A ticket solves
 * that: the client asks the API (over an ordinary authenticated request) for a short-lived,
 * single-use token and presents *that* to the gateway. A leaked ticket is worth 60 seconds and one
 * connection.
 */
export interface TicketClaims {
  kind: 'agent' | 'visitor';
  accountId: string;
  /** Membership id for agents, visitor id for visitors. */
  subjectId: string;
  propertyId?: string;
  sessionId?: string;
  userId?: string;
  memberId?: string;
  actorName?: string;
}

export class TicketService {
  constructor(private readonly redis: RedisClient) {}

  async issue(claims: TicketClaims): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ticket = generateToken(24);
    await this.redis.set(
      presenceKey.ticket(hashToken(ticket)),
      JSON.stringify(claims),
      'EX',
      REALTIME_TICKET_TTL_SECONDS,
    );
    return { ticket, expiresInSeconds: REALTIME_TICKET_TTL_SECONDS };
  }

  /**
   * Redeem a ticket, atomically.
   *
   * GETDEL is what makes it single-use: two connections racing with the same ticket cannot both
   * win, so a stolen ticket is worthless the moment the legitimate client connects.
   */
  async redeem(ticket: string): Promise<TicketClaims | null> {
    if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 256) return null;

    const raw = await this.redis.getdel(presenceKey.ticket(hashToken(ticket)));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as TicketClaims;
    } catch {
      return null;
    }
  }
}
