import type { RedisClient } from './client.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitRule {
  /** Maximum number of actions permitted inside the window. */
  limit: number;
  windowMs: number;
}

/**
 * Sliding-window log, evaluated atomically in Redis.
 *
 * A fixed-window counter allows a burst of 2× the limit across a window boundary, which for
 * "5 login attempts per 15 minutes" means 10 attempts in a few seconds. The sorted-set log costs a
 * little more memory and removes that hole entirely.
 */
const CONSUME_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - used - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = 0
if oldest[2] then
  retry = math.ceil((tonumber(oldest[2]) + window) - now)
  if retry < 0 then retry = 0 end
end
redis.call('PEXPIRE', key, window)
return {0, 0, retry}
`;

export class RateLimiter {
  private scriptSha: string | null = null;
  private counter = 0;

  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Record one action against `key` and report whether it is permitted.
   *
   * Fails **open** on a Redis error: a rate limiter outage must not lock every customer out of
   * the product. The error is surfaced to the caller's logger instead.
   */
  async consume(
    key: string,
    rule: RateLimitRule,
    onError?: (error: Error) => void,
  ): Promise<RateLimitResult> {
    const now = this.clock.timestamp();
    this.counter += 1;
    const member = `${now}-${this.counter}-${Math.round(Math.random() * 1e9)}`;

    try {
      const result = (await this.evaluate(`ratelimit:${key}`, [
        String(now),
        String(rule.windowMs),
        String(rule.limit),
        member,
      ])) as [number, number, number];

      return {
        allowed: result[0] === 1,
        limit: rule.limit,
        remaining: Number(result[1]),
        retryAfterMs: Number(result[2]),
      };
    } catch (error) {
      onError?.(error as Error);
      return { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterMs: 0 };
    }
  }

  /** Inspect without consuming — used to render "try again in N seconds" without a penalty. */
  async peek(key: string, rule: RateLimitRule): Promise<number> {
    const now = this.clock.timestamp();
    await this.redis.zremrangebyscore(`ratelimit:${key}`, 0, now - rule.windowMs);
    return this.redis.zcard(`ratelimit:${key}`);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`ratelimit:${key}`);
  }

  private async evaluate(key: string, args: string[]): Promise<unknown> {
    if (!this.scriptSha) {
      this.scriptSha = (await this.redis.script('LOAD', CONSUME_SCRIPT)) as string;
    }
    try {
      return await this.redis.evalsha(this.scriptSha, 1, key, ...args);
    } catch (error) {
      // A Redis restart clears the script cache; reload once and retry before giving up.
      if (error instanceof Error && error.message.includes('NOSCRIPT')) {
        this.scriptSha = (await this.redis.script('LOAD', CONSUME_SCRIPT)) as string;
        return this.redis.evalsha(this.scriptSha, 1, key, ...args);
      }
      throw error;
    }
  }
}

/**
 * Named limits, in one place, so the policy is reviewable rather than scattered through handlers.
 * Documented in docs/SECURITY.md §3.
 */
export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 15 * 60_000 },
  // Per IP. Deliberately not 3: an agency or a shared office behind one NAT legitimately creates
  // several accounts in an hour, and locking them out is a worse failure than the abuse it
  // prevents. Bulk signup abuse is caught by the per-email limit below plus email verification.
  register: { limit: 10, windowMs: 60 * 60_000 },
  registerEmail: { limit: 3, windowMs: 60 * 60_000 },
  forgotPassword: { limit: 3, windowMs: 60 * 60_000 },
  resendVerification: { limit: 3, windowMs: 60 * 60_000 },
  emailToken: { limit: 10, windowMs: 60 * 60_000 },
  widgetSession: { limit: 30, windowMs: 60_000 },
  visitorMessage: { limit: 20, windowMs: 60_000 },
  propertyMessage: { limit: 300, windowMs: 60_000 },
  visitorUpload: { limit: 10, windowMs: 60 * 60_000 },
  dashboardApi: { limit: 600, windowMs: 60_000 },
  mutation: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;
