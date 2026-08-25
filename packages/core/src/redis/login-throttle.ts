import type { RedisClient } from './client.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * Escalating lockout for repeated authentication failures.
 *
 * Separate from the general rate limiter because the policy is different: the rate limiter caps
 * request volume, this caps *failures* and grows the penalty, so an attacker gets a handful of
 * guesses per hour while a person who mistypes twice is barely inconvenienced.
 */
const PENALTY_LADDER_MS = [0, 0, 0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const FAILURE_TTL_SECONDS = 24 * 60 * 60;

export interface ThrottleState {
  locked: boolean;
  failures: number;
  retryAfterMs: number;
}

export class LoginThrottle {
  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock = systemClock,
  ) {}

  private failureKey(identifier: string): string {
    return `throttle:login:fail:${identifier}`;
  }

  private lockKey(identifier: string): string {
    return `throttle:login:lock:${identifier}`;
  }

  async check(identifier: string): Promise<ThrottleState> {
    const [failuresRaw, lockTtl] = await Promise.all([
      this.redis.get(this.failureKey(identifier)),
      this.redis.pttl(this.lockKey(identifier)),
    ]);
    const failures = Number(failuresRaw ?? 0);
    return {
      locked: lockTtl > 0,
      failures,
      retryAfterMs: lockTtl > 0 ? lockTtl : 0,
    };
  }

  async recordFailure(identifier: string): Promise<ThrottleState> {
    const key = this.failureKey(identifier);
    const failures = await this.redis.incr(key);
    if (failures === 1) await this.redis.expire(key, FAILURE_TTL_SECONDS);

    const index = Math.min(failures, PENALTY_LADDER_MS.length - 1);
    const penalty = PENALTY_LADDER_MS[index] ?? 0;

    if (penalty > 0) {
      await this.redis.set(this.lockKey(identifier), String(this.clock.timestamp()), 'PX', penalty);
      return { locked: true, failures, retryAfterMs: penalty };
    }
    return { locked: false, failures, retryAfterMs: 0 };
  }

  /** Called on a successful login: the ladder resets completely. */
  async recordSuccess(identifier: string): Promise<void> {
    await this.redis.del(this.failureKey(identifier), this.lockKey(identifier));
  }
}
