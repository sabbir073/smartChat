import type { FastifyReply } from 'fastify';
import type { ApiSuccessResponse } from '@smartchat/types';

/**
 * Every successful response uses the same envelope, so a client never has to guess whether it is
 * looking at a resource, a wrapper, or an error.
 */
export function ok<T>(reply: FastifyReply, data: T, meta?: Record<string, unknown>): FastifyReply {
  const body: ApiSuccessResponse<T> = meta
    ? { success: true, data, meta }
    : { success: true, data };
  return reply.send(body);
}

export function created<T>(reply: FastifyReply, data: T): FastifyReply {
  return reply.status(201).send({ success: true, data } satisfies ApiSuccessResponse<T>);
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}
