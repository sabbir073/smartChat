import type { Database } from '@smartchat/database';
import { AppError, ErrorCode, PlatformPermission } from '@smartchat/types';
import type { UpdateAiPlatformSettingsInput } from '@smartchat/validation';
import { startOfMonth } from '../billing/entitlements.js';
import { PlatformSettingKey, type PlatformSettingsService } from '../billing/settings.js';
import type { PlatformPrincipal } from '../services/platform.service.js';
import { systemClock, type Clock } from '../time.js';
import type { AiGateway } from './gateway.js';
import type { LocalHealth } from './ollama.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

/**
 * The operator's view of the AI layer: where replies are going, whether the local model is up,
 * and the fallback's key. The key is sealed like the Stripe key and never shown again.
 */

export interface AiPlatformSettingsView {
  local: {
    url: string;
    chatModel: string;
    embedModel: string;
    embedDimensions: number;
    timeoutMs: number;
  };
  fallback: {
    provider: 'none' | 'openai' | 'deepseek';
    model: string | null;
    apiKeyConfigured: boolean;
  };
  routing: 'local_first' | 'fallback_only';
  /** Where a fallback provider's default model name comes from, for the console's placeholder. */
  defaultModels: Record<'openai' | 'deepseek', string>;
}

export interface AiPlatformHealthView {
  local: (LocalHealth & { error: null }) | { reachable: false; error: string };
  breaker: { open: boolean; until: string | null; consecutiveFailures: number; inFlight: number };
}

export interface AiPlatformUsageView {
  month: { turns: number; answers: number; chats: number; tickets: number; handoffs: number; failed: number; fellBack: number; local: number; hosted: number };
  /** The accounts that used it most this month. */
  accounts: Array<{ accountId: string; accountName: string; turns: number; fellBack: number; failed: number }>;
  /** The ten most recent failures, so an outage has a face. */
  recentFailures: Array<{ at: string; accountName: string; error: string | null; provider: string | null }>;
}

export const DEFAULT_FALLBACK_MODELS: Record<'openai' | 'deepseek', string> = {
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
};

export interface PlatformAiServiceOptions {
  db: Database;
  settings: PlatformSettingsService;
  gateway: AiGateway;
  local: { url: string; chatModel: string; embedModel: string; embedDimensions: number };
  fallbackBaseUrl?: string | undefined;
  clock?: Clock;
}

function requireAiPermission(principal: PlatformPrincipal): void {
  if (!principal.permissions.has(PlatformPermission.AI_MANAGE)) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Your platform role does not include the AI settings');
  }
}

export class PlatformAiService {
  private readonly clock: Clock;

  constructor(private readonly options: PlatformAiServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async settings(principal: PlatformPrincipal): Promise<AiPlatformSettingsView> {
    requireAiPermission(principal);
    const config = await this.options.settings.ai();
    return {
      local: { ...this.options.local, timeoutMs: config.localTimeoutMs },
      fallback: {
        provider: config.fallbackProvider,
        model: config.fallbackModel,
        apiKeyConfigured: config.fallbackApiKey !== null,
      },
      routing: config.routing,
      defaultModels: DEFAULT_FALLBACK_MODELS,
    };
  }

  async updateSettings(
    principal: PlatformPrincipal,
    input: UpdateAiPlatformSettingsInput,
    ip?: string,
  ): Promise<AiPlatformSettingsView> {
    requireAiPermission(principal);
    const admin = principal.adminId;
    const changed: string[] = [];
    const set = this.options.settings;

    // Validate the combination before anything is written. A refusal that had already stored
    // half of the change would leave routing pointing at a fallback that does not exist.
    const current = await set.ai();
    const next = {
      provider: input.fallbackProvider ?? current.fallbackProvider,
      apiKey: input.fallbackApiKey === undefined ? current.fallbackApiKey : input.fallbackApiKey,
      routing: input.routing ?? current.routing,
    };
    if (next.routing === 'fallback_only' && (next.provider === 'none' || !next.apiKey)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Fallback-only routing needs a fallback provider and its API key.',
      );
    }

    if (input.fallbackProvider !== undefined) {
      await set.set(PlatformSettingKey.AI_FALLBACK_PROVIDER, input.fallbackProvider === 'none' ? null : input.fallbackProvider, admin);
      changed.push('fallbackProvider');
    }
    if (input.fallbackApiKey !== undefined) {
      await set.set(PlatformSettingKey.AI_FALLBACK_API_KEY, input.fallbackApiKey, admin);
      changed.push('fallbackApiKey');
    }
    if (input.fallbackModel !== undefined) {
      await set.set(PlatformSettingKey.AI_FALLBACK_MODEL, input.fallbackModel, admin);
      changed.push('fallbackModel');
    }
    if (input.localTimeoutMs !== undefined) {
      await set.set(PlatformSettingKey.AI_LOCAL_TIMEOUT_MS, String(input.localTimeoutMs), admin);
      changed.push('localTimeoutMs');
    }
    if (input.routing !== undefined) {
      await set.set(PlatformSettingKey.AI_ROUTING, input.routing === 'local_first' ? null : input.routing, admin);
      changed.push('routing');
    }

    await this.record(admin, 'ai.settings.updated', { changed }, ip);
    return this.settings(principal);
  }

  /** Does the fallback key work with the chosen model? One tiny completion. */
  async testFallback(principal: PlatformPrincipal): Promise<{ ok: true; provider: string; model: string }> {
    requireAiPermission(principal);
    const config = await this.options.settings.ai();
    if (config.fallbackProvider === 'none' || !config.fallbackApiKey) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a fallback provider and enter its API key first.');
    }
    const provider = new OpenAiCompatibleProvider({
      kind: config.fallbackProvider,
      apiKey: config.fallbackApiKey,
      model: config.fallbackModel ?? DEFAULT_FALLBACK_MODELS[config.fallbackProvider],
      ...(this.options.fallbackBaseUrl ? { baseUrl: this.options.fallbackBaseUrl } : {}),
    });
    const result = await provider.test();
    return { ok: true, provider: config.fallbackProvider, model: result.model };
  }

  async health(principal: PlatformPrincipal): Promise<AiPlatformHealthView> {
    requireAiPermission(principal);
    const breaker = this.options.gateway.breakerState();
    let local: AiPlatformHealthView['local'];
    if (!this.options.gateway.hasLocal) {
      local = { reachable: false, error: 'AI_LOCAL_URL is not set' };
    } else {
      try {
        local = { ...(await this.options.gateway.embeddings.health()), error: null };
      } catch (error) {
        local = { reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      local,
      breaker: {
        open: breaker.open,
        until: breaker.until?.toISOString() ?? null,
        consecutiveFailures: breaker.consecutiveFailures,
        inFlight: breaker.inFlight,
      },
    };
  }

  async usage(principal: PlatformPrincipal): Promise<AiPlatformUsageView> {
    requireAiPermission(principal);
    const since = startOfMonth(this.clock.now());
    const db = this.options.db;
    const [byDecision, fellBack, byProvider, byAccount, failures] = await Promise.all([
      db.aiTurn.groupBy({ by: ['decision'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      db.aiTurn.count({ where: { createdAt: { gte: since }, fellBack: true } }),
      db.aiTurn.groupBy({ by: ['provider'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      db.aiTurn.groupBy({
        by: ['accountId'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { accountId: 'desc' } },
        take: 20,
      }),
      db.aiTurn.findMany({
        where: { createdAt: { gte: since }, decision: 'failed' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { createdAt: true, error: true, provider: true, account: { select: { name: true } } },
      }),
    ]);

    const count = (decision: 'answer' | 'chat' | 'ticket' | 'human' | 'failed'): number =>
      byDecision.find((row) => row.decision === decision)?._count._all ?? 0;
    const turns = byDecision.reduce((sum, row) => sum + row._count._all, 0);
    const local = byProvider.find((row) => row.provider === 'local')?._count._all ?? 0;
    const hosted = byProvider
      .filter((row) => row.provider === 'openai' || row.provider === 'deepseek')
      .reduce((sum, row) => sum + row._count._all, 0);

    const accountIds = byAccount.map((row) => row.accountId);
    const [accounts, perAccountFellBack, perAccountFailed] = await Promise.all([
      db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } }),
      db.aiTurn.groupBy({
        by: ['accountId'],
        where: { createdAt: { gte: since }, accountId: { in: accountIds }, fellBack: true },
        _count: { _all: true },
      }),
      db.aiTurn.groupBy({
        by: ['accountId'],
        where: { createdAt: { gte: since }, accountId: { in: accountIds }, decision: 'failed' },
        _count: { _all: true },
      }),
    ]);
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    const fb = new Map(perAccountFellBack.map((r) => [r.accountId, r._count._all]));
    const fl = new Map(perAccountFailed.map((r) => [r.accountId, r._count._all]));

    return {
      month: {
        turns,
        answers: count('answer'),
        chats: count('chat'),
        tickets: count('ticket'),
        handoffs: count('human'),
        failed: count('failed'),
        fellBack,
        local,
        hosted,
      },
      accounts: byAccount.map((row) => ({
        accountId: row.accountId,
        accountName: names.get(row.accountId) ?? 'Unknown account',
        turns: row._count._all,
        fellBack: fb.get(row.accountId) ?? 0,
        failed: fl.get(row.accountId) ?? 0,
      })),
      recentFailures: failures.map((row) => ({
        at: row.createdAt.toISOString(),
        accountName: row.account.name,
        error: row.error,
        provider: row.provider,
      })),
    };
  }

  private async record(adminId: string, action: string, metadata: Record<string, unknown>, ip?: string): Promise<void> {
    await this.options.db.platformAuditLog
      .create({ data: { adminId, action, accountId: null, metadata: metadata as never, ip: ip ?? null } })
      .catch(() => undefined);
  }
}
