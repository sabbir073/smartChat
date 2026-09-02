import fp from 'fastify-plugin';
import { AppError, ErrorCode } from '@smartchat/types';
import { RATE_LIMITS, type RateLimitName, type RateLimiter } from '@smartchat/core';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /** Consume one unit of a named limit. Throws 429 when exhausted. */
    rateLimit(request: FastifyRequest, name: RateLimitName, subject?: string): Promise<void>;
    /**
     * Consume one unit of a limit whose size is not known until runtime.
     *
     * The named limits above are properties of the product and live in `RATE_LIMITS`. This is for
     * the ones that are properties of a *customer's plan* - the daily API allowance - where the
     * number comes from the database and differs per account.
     */
    rateLimitDynamic(
      request: FastifyRequest,
      key: string,
      rule: { limit: number; windowMs: number },
      code?: ErrorCode,
    ): Promise<void>;
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

    app.decorate(
      'rateLimitDynamic',
      async (
        request: FastifyRequest,
        key: string,
        rule: { limit: number; windowMs: number },
        code: ErrorCode = ErrorCode.RATE_LIMITED,
      ): Promise<void> => {
        if (!options.enabled) return;

        const result = await options.limiter.consume(key, rule, (error) =>
          request.log.error({ err: error }, 'rate limiter unavailable - failing open'),
        );
        if (result.allowed) return;

        // The caller chooses the code, because "you have used today's API allowance" is a billing
        // answer (402) rather than "you are going too fast" (429). The two need different actions
        // from whoever reads them.
        throw new AppError(code, undefined, {
          context: { limit: key, retryAfterMs: result.retryAfterMs },
        });
      },
    );
  },
  { name: 'rate-limit' },
);
