import fp from 'fastify-plugin';
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

function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return fromZod(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(error);
  if (error instanceof Prisma.PrismaClientValidationError) {
    return new AppError(ErrorCode.MALFORMED_REQUEST, undefined, { cause: error });
  }

  const withStatus = error as { statusCode?: number; code?: string; message?: string };
  if (withStatus?.statusCode === 413 || withStatus?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new AppError(ErrorCode.PAYLOAD_TOO_LARGE);
  }
  if (withStatus?.statusCode === 400) {
    return new AppError(ErrorCode.MALFORMED_REQUEST);
  }

  return new AppError(ErrorCode.INTERNAL_ERROR, undefined, { cause: error });
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
      reply.status(appError.status).send(body);
    });
  },
  { name: 'error-handler' },
);
