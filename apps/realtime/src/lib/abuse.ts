import { RATE_LIMITS, RateLimiter, type RedisClient } from '@smartchat/core';

/**
 * Per-socket abuse control.
 *
 * A socket is a long-lived, cheap channel, which makes it the most attractive surface in the
 * product to abuse. Limits are enforced per visitor and per property, and a client that keeps
 * violating them is disconnected rather than merely throttled - otherwise an attacker simply keeps
 * a rejected connection open and keeps trying.
 */
export const MAX_STRIKES = 10;

/** How long a strike is remembered. Long enough to outlast a reconnect, short enough to forgive. */
const STRIKE_TTL_SECONDS = 15 * 60;

export class SocketAbuseGuard {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly redis: RedisClient,
    private readonly onError: (error: Error) => void,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  /** Returns false when the action must be refused. */
  async allowMessage(subject: string, visitorId: string, propertyId: string): Promise<boolean> {
    const [perVisitor, perProperty] = await Promise.all([
      this.limiter.consume(`visitorMessage:${visitorId}`, RATE_LIMITS.visitorMessage, this.onError),
      this.limiter.consume(
        `propertyMessage:${propertyId}`,
        RATE_LIMITS.propertyMessage,
        this.onError,
      ),
    ]);

    if (perVisitor.allowed && perProperty.allowed) return true;
    await this.strike(subject);
    return false;
  }

  /**
   * Record a violation and return the running count.
   *
   * In Redis, and keyed by the visitor rather than by the socket. Both halves of that matter and
   * neither was true before: the count lived in a `Map` on one process, so an attacker who
   * reconnected - to another replica, or to the same one after a restart - started again at zero,
   * and it was keyed by socket id, so simply reconnecting reset it even on the same instance.
   * A strike counter that a reconnection clears is not a strike counter; disconnecting was all it
   * took to be forgiven, and disconnecting is exactly what the tenth strike does.
   *
   * Failure is not a violation: if Redis is unreachable the count cannot be trusted, and the
   * fail-open answer here is the right one - the per-visitor and per-property limits above are
   * what actually stop the flood, and this only decides when to hang up.
   */
  async strike(subject: string): Promise<number> {
    const key = `abuse:strikes:${subject}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, STRIKE_TTL_SECONDS);
      return count;
    } catch (error) {
      this.onError(error as Error);
      return 0;
    }
  }
}
