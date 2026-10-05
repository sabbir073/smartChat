import {
  aiEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  loadConfigOrExit,
  mailEnvSchema,
  redisEnvSchema,
  secretsEnvSchema,
  urlsEnvSchema,
  voiceEnvSchema,
} from '@smartchat/config';
import { z } from 'zod';

/**
 * What the voice agent needs to know at boot.
 *
 * It is a worker that talks: it thinks with the same brain as the chat (the AI layer, with the
 * console's encryption key to open the fallback provider's key), writes tickets (which need the
 * brand for the receipt email) and joins rooms on the media server (the voice block). Everything
 * else the worker reads - object storage, the crawler - it never touches, so it does not ask for
 * it: a required variable that nothing reads is a deploy that fails for no reason.
 */
const voiceAppEnvSchema = baseEnvSchema
  .merge(urlsEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  // The ticket receipt goes out under the product's name and support address.
  .merge(mailEnvSchema)
  .merge(aiEnvSchema)
  .merge(voiceEnvSchema)
  .merge(secretsEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('voice'),
      /** The health server, for the container check and for an operator listing live sessions. */
      PORT: z.coerce.number().int().min(1).max(65535).default(3004),
    }),
  );

export type VoiceAppConfig = z.infer<typeof voiceAppEnvSchema>;

export function loadVoiceConfig(): VoiceAppConfig {
  return loadConfigOrExit(voiceAppEnvSchema);
}

/**
 * Where this process connects to the media server.
 *
 * A join grant carries the public URL, because browsers are its usual audience. The agent runs
 * inside the Docker network, where that address may not even resolve, so it connects to the
 * same server by its internal name - `LIVEKIT_API_URL` with the scheme turned from http to ws.
 * The token is the same either way: it names the room and the identity, not the host.
 */
export function mediaSocketUrl(apiUrl: string, fallback: string): string {
  const base = apiUrl.trim() || fallback;
  if (/^wss?:\/\//i.test(base)) return base;
  return base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}
