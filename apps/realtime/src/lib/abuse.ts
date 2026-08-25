import { RATE_LIMITS, RateLimiter, type RedisClient } from '@smartchat/core';

/**
 * Per-socket abuse control.
 *
 * A socket is a long-lived, cheap channel, which makes it the most attractive surface in the
 * product to abuse. Limits are enforced per visitor and per property (shared across gateway
 * instances via Redis), and a socket that keeps violating them is disconnected rather than merely
 * throttled - otherwise an attacker simply keeps a rejected connection open and keeps trying.
 */
export const MAX_STRIKES = 10;

export class SocketAbuseGuard {
  private readonly limiter: RateLimiter;
  private readonly strikes = new Map<string, number>();

  constructor(
    redis: RedisClient,
    private readonly onError: (error: Error) => void,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  /** Returns false when the action must be refused. */
  async allowMessage(socketId: string, visitorId: string, propertyId: string): Promise<boolean> {
    const [perVisitor, perProperty] = await Promise.all([
      this.limiter.consume(`visitorMessage:${visitorId}`, RATE_LIMITS.visitorMessage, this.onError),
      this.limiter.consume(
        `propertyMessage:${propertyId}`,
        RATE_LIMITS.propertyMessage,
        this.onError,
      ),
    ]);

    if (perVisitor.allowed && perProperty.allowed) return true;
    this.strike(socketId);
    return false;
  }

  strike(socketId: string): number {
    const count = (this.strikes.get(socketId) ?? 0) + 1;
    this.strikes.set(socketId, count);
    return count;
  }

  shouldDisconnect(socketId: string): boolean {
    return (this.strikes.get(socketId) ?? 0) >= MAX_STRIKES;
  }

  forget(socketId: string): void {
    this.strikes.delete(socketId);
  }
}
