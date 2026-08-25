import { AppError, ErrorCode } from '@smartchat/types';
import type { ZodTypeAny, z } from 'zod';

/**
 * The acknowledgement envelope every client event answers with.
 *
 * Mirrors the HTTP envelope on purpose: a client that already knows how to read an API error does
 * not need a second error vocabulary for the socket.
 */
export type Ack<T> =
  { success: true; data: T } | { success: false; error: { code: string; message: string } };

export function ackOk<T>(data: T): Ack<T> {
  return { success: true, data };
}

export function ackError(error: unknown): Ack<never> {
  if (error instanceof AppError) {
    return {
      success: false,
      error: { code: error.code, message: error.expose ? error.message : 'Something went wrong' },
    };
  }
  return {
    success: false,
    error: { code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong' },
  };
}

/** Parse an untrusted socket payload. A malformed one is a client error, not a crash. */
export function parsePayload<T extends ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw new AppError(ErrorCode.VALIDATION_FAILED, undefined, {
    details: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}

/**
 * Socket.IO's acknowledgement callback is optional, so a client can omit it. Handlers must not
 * explode when it is absent.
 */
export type AckCallback<T> = ((response: Ack<T>) => void) | undefined;

export function respond<T>(callback: AckCallback<T>, response: Ack<T>): void {
  if (typeof callback === 'function') callback(response);
}
