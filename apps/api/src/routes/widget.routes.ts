import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ErrorCode } from '@smartchat/types';
import {
  widgetBootstrapSchema,
  widgetConfigQuerySchema,
  widgetIdentifySchema,
  widgetPageViewSchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { noContent, ok } from '../lib/reply.js';
import { parseBody, parseQuery } from '../lib/validate.js';

/**
 * The visitor-facing surface, mounted at /api/v1/widget.
 *
 * Every route here is reachable from any website on the internet. None of them uses cookies, none
 * of them trusts an id from the request body, and all of them are rate limited by IP or by the
 * visitor identity the token carries.
 */
export async function widgetRoutes(app: FastifyInstance, container: Container): Promise<void> {
  /** Read the visitor token from the Authorization header. Never from a cookie or the body. */
  function bearer(request: FastifyRequest): string {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length < 16) throw new AppError(ErrorCode.INVALID_TOKEN);
    return token;
  }

  /**
   * Config only. The loader calls this before it renders anything, so it must be cheap, must not
   * create a visitor, and must never return unpublished draft configuration.
   */
  app.get('/widget/config', async (request, reply) => {
    await app.rateLimit(request, 'widgetSession');
    const query = parseQuery(widgetConfigQuerySchema, request.query);
    const result = await container.visitors.publicConfig(query.p, request.headers.origin);

    // Short cache: a publish should reach installed sites within a minute, and the response is
    // identical for every visitor of a property, so it is safe to cache.
    reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return ok(reply, result);
  });

  /**
   * Start or resume a visitor. Returns the token the widget stores in its own origin's
   * localStorage - unreachable from the customer's page.
   */
  app.post('/widget/session', async (request, reply) => {
    await app.rateLimit(request, 'widgetSession');
    const input = parseBody(widgetBootstrapSchema, request.body);

    const result = await container.visitors.bootstrap({
      publicId: input.p,
      origin: request.headers.origin,
      token: input.token,
      page: input.page,
      screen: input.screen,
      language: input.language,
      timezone: input.timezone,
      ip: request.clientIp,
      userAgent: request.headers['user-agent'],
      requestId: request.requestId,
    });

    reply.header('cache-control', 'no-store');
    return ok(reply, result);
  });

  app.post('/widget/page-view', async (request, reply) => {
    const token = bearer(request);
    await app.rateLimit(request, 'widgetSession');
    const input = parseBody(widgetPageViewSchema, request.body);
    await container.visitors.recordPageView(token, input);
    return noContent(reply);
  });

  app.post('/widget/identify', async (request, reply) => {
    const token = bearer(request);
    await app.rateLimit(request, 'widgetSession');
    const input = parseBody(widgetIdentifySchema, request.body);
    await container.visitors.identify(token, input);
    return noContent(reply);
  });

  /** Lets the panel confirm its stored token is still valid before it renders a chat. */
  app.get('/widget/me', async (request, reply) => {
    const identity = await container.visitors.authenticate(bearer(request));
    reply.header('cache-control', 'no-store');
    return ok(reply, {
      visitor: {
        id: identity.visitor.id,
        name: identity.visitor.name,
        email: identity.visitor.email,
      },
      sessionId: identity.sessionId,
    });
  });
}
