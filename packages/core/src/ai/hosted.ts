import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { ChatProvider } from './provider.js';

/**
 * The hosted providers, by name. Used for the platform's fallback and for an account's own key;
 * the one place that knows which class answers to which name and what its default model is.
 */

export type HostedProviderKind = 'openai' | 'deepseek' | 'anthropic';

export const HOSTED_PROVIDERS: readonly HostedProviderKind[] = ['openai', 'deepseek', 'anthropic'];

export const DEFAULT_FALLBACK_MODELS: Record<HostedProviderKind, string> = {
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  anthropic: 'claude-haiku-4-5',
};

export function isHostedProviderKind(value: unknown): value is HostedProviderKind {
  return value === 'openai' || value === 'deepseek' || value === 'anthropic';
}

export interface HostedProvider extends ChatProvider {
  test(timeoutMs?: number): Promise<{ model: string }>;
}

export function hostedProvider(options: {
  kind: HostedProviderKind;
  apiKey: string;
  model?: string | null | undefined;
  baseUrl?: string | undefined;
}): HostedProvider {
  const model = options.model || DEFAULT_FALLBACK_MODELS[options.kind];
  if (options.kind === 'anthropic') {
    return new AnthropicProvider({ apiKey: options.apiKey, model, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
  }
  return new OpenAiCompatibleProvider({
    kind: options.kind,
    apiKey: options.apiKey,
    model,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}
