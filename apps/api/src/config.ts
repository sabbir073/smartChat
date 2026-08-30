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
      /**
       * Development only: allow a webhook to point at a private address.
       *
       * A webhook URL is an address this server makes outbound requests to on a schedule the
       * account controls, which is a server-side request forgery primitive if left open - so in
       * production it must be https on a public host. A test receiver has to run somewhere
       * though, and in development that somewhere is this machine. Defaults to **false**: the
       * unsafe behaviour is opted into by configuration, never inherited.
       */
      /**
       * Enables `/metrics`. Absent means the endpoint returns 404 and does not exist.
       *
       * Opt-in rather than opt-out: an unauthenticated metrics endpoint tells a stranger how many
       * customers you have and whether your queues are backing up, and "we forgot to set a token"
       * is a much more common failure than "we forgot to enable metrics".
       */
      METRICS_TOKEN: z.string().min(16).optional(),
      ALLOW_PRIVATE_WEBHOOK_URLS: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .default(false)
        .transform((v) => v === true || v === 'true' || v === '1'),
    }),
  );

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfigOrExit(apiEnvSchema);
}
