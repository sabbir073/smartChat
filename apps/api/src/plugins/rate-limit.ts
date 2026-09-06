import fp from 'fastify-plugin';
import { AppError, ErrorCode } from '@smartchat/types';
import { RATE_LIMITS, type RateLimitName, type RateLimiter } from '@smartchat/core';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /** Consume one unit of a named limit. Throws 429 when exhausted. */
    rateLimit(request: FastifyRequest, name: RateLimitName, subject?: string): Promise<void>;
  }
}

export const rateLimitPlugin = fp<{ limiter: RateLimiter; enabled: boolean }>(
  async (app, options) => {
    app.decorate(
      'rateLimit',
      async (request: FastifyRequest, name: RateLimitName, subject?: string): Promise<void> => {
        if (!options.enabled) return;

        // Default subject is the client IP. Callers pass something narrower (email, visitor id,
        // property id) when the limit should follow the actor rather than the connection.
        const key = `${name}:${subject ?? request.clientIp ?? 'unknown'}`;
        const result = await options.limiter.consume(key, RATE_LIMITS[name], (error) =>
          request.log.error({ err: error }, 'rate limiter unavailable — failing open'),
        );

        if (!result.allowed) {
          throw new AppError(ErrorCode.RATE_LIMITED, undefined, {
            context: { limit: name, retryAfterMs: result.retryAfterMs },
          });
        }
      },
    );
  },
  { name: 'rate-limit' },
);
