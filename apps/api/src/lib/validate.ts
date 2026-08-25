import { AppError, ErrorCode, type ErrorDetail } from '@smartchat/types';
import { type ZodError, type ZodTypeAny, type z } from 'zod';

function toDetails(error: ZodError, prefix: string): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

/**
 * Parse untrusted input against a schema.
 *
 * Every field-level problem is returned at once so a form can highlight all of them, and the
 * parsed value is the *only* thing handlers use — the raw request object is never read past this
 * point.
 */
export function parse<T extends ZodTypeAny>(schema: T, input: unknown, source: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(ErrorCode.VALIDATION_FAILED, undefined, {
    details: toDetails(result.error, source),
  });
}

export const parseBody = <T extends ZodTypeAny>(schema: T, input: unknown) =>
  parse(schema, input, 'body');

export const parseQuery = <T extends ZodTypeAny>(schema: T, input: unknown) =>
  parse(schema, input, 'query');

export const parseParams = <T extends ZodTypeAny>(schema: T, input: unknown) =>
  parse(schema, input, 'params');
