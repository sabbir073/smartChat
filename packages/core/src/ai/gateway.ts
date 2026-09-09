import { AppError, ErrorCode } from '@smartchat/types';
import { systemClock, type Clock } from '../time.js';
import type { OllamaProvider } from './ollama.js';
import {
  AiTimeoutError,
  type AiProviderKind,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
} from './provider.js';

/**
 * Local first, hosted second.
 *
 * The operator's rule: the local model has priority, and the hosted fallback (OpenAI or DeepSeek,
 * configured in the console) is for when the local one cannot answer. "Cannot answer" is three
 * things here, and each is handled without a visitor noticing:
 *
 *   - it fails or times out: the same request goes to the fallback, and the failure is counted;
 *   - it has failed several times running: the breaker opens and the fallback takes every request
 *     for a minute, so an outage costs one slow reply rather than one per visitor;
 *   - it is busy: the local server works on `localParallel` replies at once and queues the rest.
 *     Rather than queue, anything beyond that goes to the fallback, which is what "fallback for
 *     capacity" means on a CPU box.
 *
 * With no fallback configured the local model is simply waited for, and only a hard failure
 * surfaces as `AI_UNAVAILABLE`. Embeddings are always local: the index is built with one model
 * and a query embedded with another would be measured in the wrong space.
 */

export interface AiRoutingConfig {
  localTimeoutMs: number;
  routing: 'local_first' | 'fallback_only';
}

export interface AiGatewayOptions {
  local: OllamaProvider | null;
  /** The fallback, or null when none is configured. Read per call so a console change applies at once. */
  fallback: () => Promise<ChatProvider | null>;
  config: () => Promise<AiRoutingConfig>;
  /**
   * An account's own hosted provider, when it has one. It replaces the platform fallback for
   * that account - its key, its bill - and with `own_only` it replaces the local model too.
   */
  accountRoute?: (accountId: string) => Promise<{ provider: ChatProvider; routing: 'local_first' | 'own_only' } | null>;
  /** Requests the local server handles at once before the rest overflow. Matches OLLAMA_NUM_PARALLEL. */
  localParallel?: number;
  /** Consecutive local failures that open the breaker, and for how long. */
  breakerThreshold?: number;
  breakerOpenMs?: number;
  fallbackTimeoutMs?: number;
  clock?: Clock;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface CompletionOutcome {
  result: ChatResult;
  provider: AiProviderKind;
  /** True when the local model was skipped or failed and the fallback answered. */
  fellBack: boolean;
  /** Why it fell back, for the turn record. */
  fallbackReason?: string;
}

export class AiGateway {
  private readonly clock: Clock;
  private readonly localParallel: number;
  private readonly breakerThreshold: number;
  private readonly breakerOpenMs: number;
  private readonly fallbackTimeoutMs: number;
  private localFailures = 0;
  private breakerOpenUntil = 0;
  private localInFlight = 0;

  constructor(private readonly options: AiGatewayOptions) {
    this.clock = options.clock ?? systemClock;
    this.localParallel = options.localParallel ?? 2;
    this.breakerThreshold = options.breakerThreshold ?? 3;
    this.breakerOpenMs = options.breakerOpenMs ?? 60_000;
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? 30_000;
  }

  get hasLocal(): boolean {
    return this.options.local !== null;
  }

  /** The embedding model, for the indexer and retrieval. Local only; see above. */
  get embeddings(): OllamaProvider {
    if (!this.options.local) {
      throw new AppError(ErrorCode.AI_UNAVAILABLE, 'The local AI service is not configured');
    }
    return this.options.local;
  }

  /** What the console shows. */
  breakerState(): { open: boolean; until: Date | null; consecutiveFailures: number; inFlight: number } {
    const now = this.clock.timestamp();
    const open = this.breakerOpenUntil > now;
    return {
      open,
      until: open ? new Date(this.breakerOpenUntil) : null,
      consecutiveFailures: this.localFailures,
      inFlight: this.localInFlight,
    };
  }

  async complete(
    request: Omit<ChatRequest, 'timeoutMs'>,
    scope: { accountId?: string } = {},
  ): Promise<CompletionOutcome> {
    const [config, platformFallback, own] = await Promise.all([
      this.options.config(),
      this.options.fallback(),
      scope.accountId && this.options.accountRoute ? this.options.accountRoute(scope.accountId) : null,
    ]);
    const local = this.options.local;

    if (own?.routing === 'own_only') {
      return this.viaFallback(own.provider, request, "account's own provider (own_only)");
    }
    const fallback = own ? own.provider : platformFallback;

    if (config.routing === 'fallback_only') {
      if (fallback) return this.viaFallback(fallback, request, 'routing is fallback_only');
      if (!local) throw unavailable('No AI provider is configured');
      // The operator asked for fallback-only but has not configured one. Local is better than
      // nothing, and the console says so.
    }

    if (!local) {
      if (fallback) return this.viaFallback(fallback, request, 'no local model configured');
      throw unavailable('No AI provider is configured');
    }

    const now = this.clock.timestamp();
    if (this.breakerOpenUntil > now) {
      if (fallback) return this.viaFallback(fallback, request, 'local breaker open');
      // No fallback: try local anyway. The breaker only exists to route around it.
    } else if (this.localInFlight >= this.localParallel && fallback) {
      return this.viaFallback(fallback, request, `local busy (${this.localInFlight} in flight)`);
    }

    this.localInFlight += 1;
    try {
      const result = await local.chat({ ...request, timeoutMs: config.localTimeoutMs });
      this.localFailures = 0;
      return { result, provider: 'local', fellBack: false };
    } catch (error) {
      this.recordLocalFailure(error);
      if (!fallback) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      return this.viaFallback(fallback, request, `local failed: ${reason}`);
    } finally {
      this.localInFlight -= 1;
    }
  }

  private async viaFallback(
    fallback: ChatProvider,
    request: Omit<ChatRequest, 'timeoutMs'>,
    reason: string,
  ): Promise<CompletionOutcome> {
    this.options.log?.('ai.fallback', { provider: fallback.kind, model: fallback.model, reason });
    const result = await fallback.chat({ ...request, timeoutMs: this.fallbackTimeoutMs });
    return { result, provider: fallback.kind, fellBack: true, fallbackReason: reason };
  }

  private recordLocalFailure(error: unknown): void {
    this.localFailures += 1;
    const detail = {
      failures: this.localFailures,
      timeout: error instanceof AiTimeoutError,
      message: error instanceof Error ? error.message : String(error),
    };
    if (this.localFailures >= this.breakerThreshold) {
      this.breakerOpenUntil = this.clock.timestamp() + this.breakerOpenMs;
      this.options.log?.('ai.local.breaker_open', { ...detail, openMs: this.breakerOpenMs });
    } else {
      this.options.log?.('ai.local.failure', detail);
    }
  }
}

function unavailable(message: string): AppError {
  return new AppError(ErrorCode.AI_UNAVAILABLE, message);
}
