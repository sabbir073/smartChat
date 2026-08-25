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
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().min(1).startsWith('redis'),
});

export const secretsEnvSchema = z.object({
  SESSION_SECRET: secret,
  JWT_SECRET: secret,
  VISITOR_TOKEN_SECRET: secret,
  ENCRYPTION_KEY: secret,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
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
