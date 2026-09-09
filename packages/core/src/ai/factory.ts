import type { PlatformSettingsService } from '../billing/settings.js';
import type { Clock } from '../time.js';
import { AiGateway } from './gateway.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { DEFAULT_FALLBACK_MODELS } from './platform-ai.service.js';
import type { ChatProvider } from './provider.js';

/**
 * The gateway as the apps build it: the local provider from the environment, the fallback from
 * the console settings, re-read every thirty seconds so a key pasted in the console is used
 * without a restart - the same arrangement as the Stripe client.
 */

export interface AiLocalEnv {
  /** Empty string or undefined disables the local provider (tests, an installation on hosted only). */
  url: string | undefined;
  chatModel: string;
  embedModel: string;
  embedDimensions: number;
  parallel: number;
  /** Overrides the fallback provider's endpoint. Empty/undefined means the provider's own. */
  fallbackBaseUrl?: string | undefined;
}

export function createAiGateway(
  env: AiLocalEnv,
  settings: PlatformSettingsService,
  options: { clock?: Clock; log?: (event: string, detail: Record<string, unknown>) => void; cacheMs?: number } = {},
): AiGateway {
  const local = env.url
    ? new OllamaProvider({
        baseUrl: env.url,
        chatModel: env.chatModel,
        embedModel: env.embedModel,
        embedDimensions: env.embedDimensions,
      })
    : null;

  const cacheMs = options.cacheMs ?? 30_000;
  let cached: { at: number; fallback: ChatProvider | null; config: { localTimeoutMs: number; routing: 'local_first' | 'fallback_only' } } | null = null;

  const load = async () => {
    const now = Date.now();
    if (cached && now - cached.at < cacheMs) return cached;
    const config = await settings.ai();
    let fallback: ChatProvider | null = null;
    if (config.fallbackProvider !== 'none' && config.fallbackApiKey) {
      fallback = new OpenAiCompatibleProvider({
        kind: config.fallbackProvider,
        apiKey: config.fallbackApiKey,
        model: config.fallbackModel ?? DEFAULT_FALLBACK_MODELS[config.fallbackProvider],
        ...(env.fallbackBaseUrl ? { baseUrl: env.fallbackBaseUrl } : {}),
      });
    }
    cached = { at: now, fallback, config: { localTimeoutMs: config.localTimeoutMs, routing: config.routing } };
    return cached;
  };

  return new AiGateway({
    local,
    fallback: async () => (await load()).fallback,
    config: async () => (await load()).config,
    localParallel: env.parallel,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}
