import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export interface LogContext {
  requestId?: string;
  accountId?: string;
  propertyId?: string;
  conversationId?: string;
  userId?: string;
  visitorId?: string;
  socketId?: string;
  jobId?: string;
}

/**
 * Fields that must never reach a log sink, matched by pino's redaction paths.
 *
 * This list is the reason we can log request bodies at debug level without leaking credentials.
 */
export const REDACT_PATHS = [
  'password',
  'passwordConfirmation',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'body.password',
  'body.token',
  'headers.authorization',
  'headers.cookie',
];

const storage = new AsyncLocalStorage<LogContext>();

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, ...options.base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    /** Merge the ambient request context into every line, so callers never have to pass it. */
    mixin: () => storage.getStore() ?? {},
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (options.pretty) {
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    });
  }

  return pino(pinoOptions);
}

/** Run `fn` with these fields attached to every log line it produces, at any depth. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...context };
  return storage.run(merged, fn);
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Add fields to the *current* context without opening a new scope. */
export function addLogContext(context: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, context);
}
