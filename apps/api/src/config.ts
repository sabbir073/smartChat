import {
  baseEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadConfigOrExit,
  mailEnvSchema,
  redisEnvSchema,
  secretsEnvSchema,
  storageEnvSchema,
  urlsEnvSchema,
} from '@smartchat/config';
import { z } from 'zod';

const apiEnvSchema = baseEnvSchema
  .merge(urlsEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(secretsEnvSchema)
  .merge(mailEnvSchema)
  .merge(httpEnvSchema)
  .merge(storageEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('api'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      /** Development only: skip the email verification step when creating an account. */
      AUTO_VERIFY_EMAIL: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .default(false)
        .transform((v) => v === true || v === 'true' || v === '1'),
      /** Development only: accept widget requests from localhost regardless of allowed domains. */
      ALLOW_LOCALHOST_ORIGINS: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .default(true)
        .transform((v) => v === true || v === 'true' || v === '1'),
    }),
  );

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfigOrExit(apiEnvSchema);
}
