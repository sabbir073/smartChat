import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type ApiErrorResponse } from '@smartchat/types';
import { Prisma } from '@smartchat/database';

function fromZod(error: ZodError): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, undefined, {
    details: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}

/**
 * Translate a Prisma error into a domain error.
 *
 * The point is that a driver-level failure never escapes as a 500 with a message describing our
 * schema. A unique violation is a 409 the client can act on; anything else is opaque.
 */
function fromPrisma(error: Prisma.PrismaClientKnownRequestError): AppError {
  switch (error.code) {
    case 'P2002':
      return new AppError(ErrorCode.CONFLICT, 'That value is already in use', {
        context: { prismaCode: error.code, target: error.meta?.['target'] },
      });
    case 'P2025':
      return new AppError(ErrorCode.NOT_FOUND, undefined, {
        context: { prismaCode: error.code },
      });
    case 'P2003':
      return new AppError(ErrorCode.CONFLICT, 'A related record is missing', {
        context: { prismaCode: error.code },
      });
    default:
      return new AppError(ErrorCode.INTERNAL_ERROR, undefined, {
        context: { prismaCode: error.code },
        cause: error,
      });
  }
}

/**
 * Fastify's own failures, translated.
 *
 * These are raised during routing and body parsing - before any handler runs - and a few of them
 * never reach `setErrorHandler` at all. Left alone, Fastify answers them in its own envelope:
 * `{"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH","message":"'/api/v1/tickets/000...'"}`
 * - a different shape from every other error this API returns, naming the framework and echoing
 * the caller's URL back at them. A client parsing our envelope finds no code and no message there
 * and has nothing to show a person.
 */
const FRAMEWORK_ERRORS: Readonly<Record<string, ErrorCode>> = {
  // A path segment longer than the router will match. Not "not found" - the URL is not a shape
  // this API accepts at all.
  FST_ERR_MAX_PARAM_LENGTH: ErrorCode.MALFORMED_REQUEST,
  FST_ERR_BAD_URL: ErrorCode.MALFORMED_REQUEST,
  FST_ERR_CTP_EMPTY_JSON_BODY: ErrorCode.MALFORMED_REQUEST,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: ErrorCode.MALFORMED_REQUEST,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: ErrorCode.MALFORMED_REQUEST,
  FST_ERR_CTP_BODY_TOO_LARGE: ErrorCode.PAYLOAD_TOO_LARGE,
  FST_ERR_ASYNC_CONSTRAINT: ErrorCode.MALFORMED_REQUEST,
};

function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return fromZod(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(error);
  if (error instanceof Prisma.PrismaClientValidationError) {
    return new AppError(ErrorCode.MALFORMED_REQUEST, undefined, { cause: error });
  }

  const withStatus = error as { statusCode?: number; code?: string; message?: string };

  const mapped = withStatus?.code ? FRAMEWORK_ERRORS[withStatus.code] : undefined;
  // `context` carries the framework's own code so it is in the log; it is never serialised.
  if (mapped)
    return new AppError(mapped, undefined, { context: { frameworkCode: withStatus.code } });

  if (withStatus?.statusCode === 413) return new AppError(ErrorCode.PAYLOAD_TOO_LARGE);
  // Any other 4xx the framework raises is the caller's request being wrong in a way we have not
  // named. Deliberately generic rather than passing the framework's message through.
  if (withStatus?.statusCode && withStatus.statusCode >= 400 && withStatus.statusCode < 500) {
    return new AppError(ErrorCode.MALFORMED_REQUEST, undefined, {
      context: { frameworkCode: withStatus.code, frameworkStatus: withStatus.statusCode },
      cause: error,
    });
  }

  return new AppError(ErrorCode.INTERNAL_ERROR, undefined, { cause: error });
}

/**
 * The one place an error becomes a response.
 *
 * Exported because there are two doors into it - Fastify's `setErrorHandler` for anything a
 * handler throws, and its `frameworkErrors` option for the routing and parsing failures that never
 * reach a handler. Two functions that both "turn an error into a response" is exactly how the two
 * shapes drift apart, so there is one.
 */
export function sendAppError(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const appError = normalise(error);

  // 5xx is our fault and gets the full picture; 4xx is the caller's and stays quiet.
  if (appError.status >= 500) {
    request.log.error(
      { err: error, code: appError.code, context: appError.context },
      'request failed',
    );
  } else {
    request.log.info(
      { code: appError.code, status: appError.status, context: appError.context },
      'request rejected',
    );
  }

  if (appError.code === ErrorCode.RATE_LIMITED) {
    const retryAfterMs = Number(appError.context?.['retryAfterMs'] ?? 0);
    reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }

  const body: ApiErrorResponse = {
    success: false,
    error: appError.toBody(request.requestId),
  };
  void reply.status(appError.status).send(body);
}

export const errorHandlerPlugin = fp(
  async (app) => {
    app.setNotFoundHandler((request, reply) => {
      const body: ApiErrorResponse = {
        success: false,
        error: {
          code: ErrorCode.NOT_FOUND,
          message: 'Not found',
          requestId: request.requestId,
        },
      };
      reply.status(404).send(body);
    });

    app.setErrorHandler((error, request, reply) => {
      sendAppError(error, request, reply);
    });
  },
  { name: 'error-handler' },
);
