import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import { addLogContext, withLogContext } from '@smartchat/logger';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    clientIp: string | undefined;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Give every request an id and an ambient log context.
 *
 * Because the context lives in AsyncLocalStorage, any log line produced anywhere in the request —
 * including inside a repository three layers down — carries the request, account and conversation
 * ids without a single function having to thread them through.
 */
export const requestContextPlugin = fp(
  async (app) => {
    app.decorateRequest('requestId', '');
    app.decorateRequest('clientIp', undefined);

    app.addHook('onRequest', (request, reply, done) => {
      const inbound = request.headers[REQUEST_ID_HEADER];
      // An inbound id is accepted only from a trusted proxy, and only in a safe shape — otherwise
      // a caller could poison log correlation with arbitrary text.
      const candidate = typeof inbound === 'string' ? inbound : undefined;
      const requestId =
        candidate && /^[A-Za-z0-9_-]{8,64}$/.test(candidate) ? candidate : randomUUID();

      request.requestId = requestId;
      request.clientIp = request.ip;
      reply.header(REQUEST_ID_HEADER, requestId);

      withLogContext({ requestId }, () => {
        done();
      });
    });

    app.addHook('preHandler', (request, _reply, done) => {
      addLogContext({ requestId: request.requestId });
      done();
    });
  },
  { name: 'request-context' },
);
