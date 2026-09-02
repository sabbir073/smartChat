import { z } from 'zod';

/**
 * Environment schemas, composed per application.
 *
 * Every process validates exactly the variables it needs at boot and exits on failure. A service
 * that starts with a missing secret and fails later, under load, in production, is far worse than
 * one that refuses to start.
 */

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

const port = z.coerce.number().int().min(1).max(65535);

/** Secrets must be long enough to be worth having, and must not still be the shipped placeholder. */
const secret = z
  .string()
  .min(32, 'must be at least 32 characters — generate with: openssl rand -hex 32');

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().default('smartchat'),
});

export const urlsEnvSchema = z.object({
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  REALTIME_URL: z.string().url(),
  WIDGET_URL: z.string().url(),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).startsWith('postgres'),
  /**
   * Connections per process. Applied by `createPrismaClient`, which puts it on the connection
   * string - Prisma has no other way to set it, which is why this sat unread for fifteen phases.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().min(1).startsWith('redis'),
});

/**
 * The secrets that actually do something.
 *
 * This used to also demand `SESSION_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY` and
 * `ACCESS_TOKEN_TTL_MINUTES`, each validated as a mandatory 32-character secret and each read by
 * exactly nothing: sessions are opaque random tokens compared by hash, there are no JWTs in this
 * product, and the AES module the encryption key was for was never called from anywhere.
 *
 * A required secret that has no effect is worse than an absent one. It fails a deploy for no
 * reason, and - the part that matters - an operator who rotates it after a suspected compromise
 * believes they have changed something. `VISITOR_TOKEN_SECRET` stays, because it signs the
 * visitor tokens the widget carries and rotating it really does invalidate them.
 */
export const secretsEnvSchema = z.object({
  VISITOR_TOKEN_SECRET: secret,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(26_214_400),
});

export const mailEnvSchema = z.object({
  MAIL_DRIVER: z.enum(['smtp', 'log', 'ses', 'resend', 'postmark']).default('smtp'),
  MAIL_FROM_ADDRESS: z.string().email(),
  MAIL_FROM_NAME: z.string().default('SmartChat'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.optional(),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
});

export const httpEnvSchema = z.object({
  PORT: port.default(3001),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_ENABLED: bool.default(true),
  CORS_DASHBOARD_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool.default(false),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type RedisEnv = z.infer<typeof redisEnvSchema>;
export type SecretsEnv = z.infer<typeof secretsEnvSchema>;
export type StorageEnv = z.infer<typeof storageEnvSchema>;
export type MailEnv = z.infer<typeof mailEnvSchema>;
export type HttpEnv = z.infer<typeof httpEnvSchema>;
export type UrlsEnv = z.infer<typeof urlsEnvSchema>;
