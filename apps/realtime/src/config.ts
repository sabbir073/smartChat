import {
  baseEnvSchema,
  databaseEnvSchema,
  loadConfigOrExit,
  redisEnvSchema,
  secretsEnvSchema,
  urlsEnvSchema,
} from '@smartchat/config';
import { z } from 'zod';

const realtimeEnvSchema = baseEnvSchema
  .merge(urlsEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(secretsEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('realtime'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3002),
      HOST: z.string().default('0.0.0.0'),
      /** Ping interval and timeout, in milliseconds. Socket.IO's liveness detection. */
      SOCKET_PING_INTERVAL_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),
      SOCKET_PING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
      /** Largest accepted frame. A message is capped at 8 KB of text; this bounds the envelope. */
      SOCKET_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).default(65_536),
      CORS_DASHBOARD_ORIGINS: z
        .string()
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
    }),
  );

export type RealtimeConfig = z.infer<typeof realtimeEnvSchema>;

export function loadRealtimeConfig(): RealtimeConfig {
  return loadConfigOrExit(realtimeEnvSchema);
}
