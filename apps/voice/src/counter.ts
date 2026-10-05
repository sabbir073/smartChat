import type { RedisClient } from '@smartchat/core';
import { presenceKey } from '@smartchat/types';

/** The counter's safety net: a session that died without saying so stops counting after an hour. */
const COUNTER_TTL_SECONDS = 3_600;

/**
 * How many calls the AI is on, server-wide.
 *
 * The call service reads this number before it hands a call to the AI, so it must be right when
 * a session starts and right again when it ends - whichever way it ends. The hour's expiry is
 * for the way nobody plans for: a process killed between the two, which would otherwise keep a
 * phantom call on the books and, at a cap of one, keep the AI off the phone until somebody
 * noticed. A session longer than an hour refreshes it with its own increment, and is in any
 * case ended by the owner's time limit long before.
 */
export class AiCallCounter {
  constructor(private readonly redis: RedisClient) {}

  async increment(): Promise<number> {
    const key = presenceKey.aiCalls();
    const count = await this.redis.incr(key);
    await this.redis.expire(key, COUNTER_TTL_SECONDS);
    return count;
  }

  async decrement(): Promise<number> {
    const key = presenceKey.aiCalls();
    const count = await this.redis.decr(key);
    // Nothing on the phone: the key goes, so an expiry can never leave a negative behind.
    if (count <= 0) await this.redis.del(key);
    return Math.max(0, count);
  }
}
