import type { AccountAiSetting, Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import type { EntitlementService } from '../billing/entitlements.js';
import { SecretBox } from '../crypto/secretbox.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import { DEFAULT_FALLBACK_MODELS, hostedProvider, type HostedProvider, type HostedProviderKind } from './hosted.js';

/**
 * An account's own hosted-model key: bring your own OpenAI, DeepSeek or Anthropic.
 *
 * With a key here the account's replies go to its provider instead of the platform fallback -
 * their key, their bill - and `routing` says whether the local model is still tried first
 * (the default; the operator's rule that local has priority holds unless the account opts out)
 * or their provider answers everything. The key is sealed with the settings key and opened only
 * to build the provider; the API returns the last four characters and nothing more.
 *
 * Gated by the plan's `aiOwnKey` flag, which the Custom plan carries.
 */

export interface AccountAiView {
  /** Whether this plan allows an own key at all. */
  allowed: boolean;
  planName: string;
  configured: boolean;
  provider: HostedProviderKind | null;
  model: string | null;
  routing: 'local_first' | 'own_only';
  /** The last four characters of the stored key, to recognise it by. */
  keyHint: string | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  defaultModels: Record<HostedProviderKind, string>;
}

export interface AccountAiUpdate {
  provider?: HostedProviderKind;
  /** A new key. Omitted keeps the stored one. */
  apiKey?: string;
  model?: string | null;
  routing?: 'local_first' | 'own_only';
}

/** What the gateway needs per account: a provider to send to, and whether local still goes first. */
export interface AccountAiRoute {
  provider: HostedProvider;
  routing: 'local_first' | 'own_only';
}

export class AccountAiService {
  private readonly box: SecretBox;
  private readonly audit: AuditRepository;
  private readonly clock: Clock;

  constructor(
    private readonly options: {
      db: Database;
      entitlements: EntitlementService;
      encryptionKeyHex: string;
      /** Overrides every hosted provider's endpoint. Tests point it at a stub. */
      baseUrl?: string | undefined;
      clock?: Clock;
    },
  ) {
    this.box = new SecretBox(options.encryptionKeyHex);
    this.audit = new AuditRepository(options.db);
    this.clock = options.clock ?? systemClock;
  }

  async get(context: TenantContext): Promise<AccountAiView> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    const [row, entitlements] = await Promise.all([
      this.options.db.accountAiSetting.findUnique({ where: { accountId: context.accountId } }),
      this.options.entitlements.forAccount(context.accountId),
    ]);
    return this.view(row, entitlements.plan.aiOwnKey, entitlements.plan.name);
  }

  async update(context: TenantContext, input: AccountAiUpdate): Promise<AccountAiView> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    await this.options.entitlements.assertFeature(context.accountId, 'aiOwnKey');
    const existing = await this.options.db.accountAiSetting.findUnique({ where: { accountId: context.accountId } });
    const provider = input.provider ?? existing?.provider;
    if (!provider || provider === 'local') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a provider: OpenAI, DeepSeek or Anthropic.');
    }
    const apiKey = input.apiKey ?? (existing ? this.box.open(existing.apiKeySealed) : null);
    if (!apiKey) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter the API key.');
    const model =
      input.model === undefined
        ? existing && existing.provider === provider
          ? existing.model
          : DEFAULT_FALLBACK_MODELS[provider]
        : input.model || DEFAULT_FALLBACK_MODELS[provider];
    const routing = input.routing ?? existing?.routing ?? 'local_first';

    // The key is checked before it is kept: a key that does not work is a support ticket later.
    const test = await this.testKey({ kind: provider, apiKey, model });
    if (!test.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `The provider refused the key or the model: ${test.error}`);
    }

    const saved = await this.options.db.accountAiSetting.upsert({
      where: { accountId: context.accountId },
      create: {
        accountId: context.accountId,
        provider,
        apiKeySealed: this.box.seal(apiKey),
        model,
        routing,
        lastTestedAt: this.clock.now(),
        lastTestError: null,
      },
      update: {
        provider,
        ...(input.apiKey ? { apiKeySealed: this.box.seal(apiKey) } : {}),
        model,
        routing,
        lastTestedAt: this.clock.now(),
        lastTestError: null,
      },
    });
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.own_key.updated',
      resourceType: 'account',
      resourceId: context.accountId,
      ip: context.ip ?? null,
      metadata: { provider, model, routing, keyChanged: Boolean(input.apiKey) },
    });
    const entitlements = await this.options.entitlements.forAccount(context.accountId);
    return this.view(saved, entitlements.plan.aiOwnKey, entitlements.plan.name);
  }

  async remove(context: TenantContext): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const deleted = await this.options.db.accountAiSetting.deleteMany({ where: { accountId: context.accountId } });
    if (deleted.count === 0) return;
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'ai.own_key.removed',
      resourceType: 'account',
      resourceId: context.accountId,
      ip: context.ip ?? null,
      metadata: {},
    });
  }

  /** The "Test" button: is the stored key still good? The outcome is kept on the row. */
  async test(context: TenantContext): Promise<{ ok: boolean; model?: string; error?: string }> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const row = await this.options.db.accountAiSetting.findUnique({ where: { accountId: context.accountId } });
    if (!row || row.provider === 'local') throw new AppError(ErrorCode.NOT_FOUND, 'No key is stored.');
    const outcome = await this.testKey({ kind: row.provider, apiKey: this.box.open(row.apiKeySealed), model: row.model });
    await this.options.db.accountAiSetting.update({
      where: { accountId: context.accountId },
      data: { lastTestedAt: this.clock.now(), lastTestError: outcome.ok ? null : outcome.error },
    });
    return outcome;
  }

  /**
   * For the gateway: the account's provider, or null when it has none or its plan no longer
   * allows one (a downgrade must not keep spending on a key the plan no longer covers - and must
   * not keep using it without the plan, either).
   */
  async routeFor(accountId: string): Promise<AccountAiRoute | null> {
    const row = await this.options.db.accountAiSetting.findUnique({ where: { accountId } });
    if (!row || row.provider === 'local') return null;
    const allowed = await this.options.entitlements.hasFeature(accountId, 'aiOwnKey');
    if (!allowed) return null;
    let apiKey: string;
    try {
      apiKey = this.box.open(row.apiKeySealed);
    } catch {
      return null;
    }
    return {
      provider: hostedProvider({ kind: row.provider, apiKey, model: row.model, baseUrl: this.options.baseUrl }),
      routing: row.routing,
    };
  }

  private async testKey(input: { kind: HostedProviderKind; apiKey: string; model: string }): Promise<{ ok: boolean; model?: string; error?: string }> {
    try {
      const result = await hostedProvider({ ...input, baseUrl: this.options.baseUrl }).test();
      return { ok: true, model: result.model };
    } catch (error) {
      return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  private view(row: AccountAiSetting | null, allowed: boolean, planName: string): AccountAiView {
    let keyHint: string | null = null;
    if (row) {
      try {
        keyHint = this.box.open(row.apiKeySealed).slice(-4);
      } catch {
        keyHint = null;
      }
    }
    return {
      allowed,
      planName,
      configured: row !== null,
      provider: row && row.provider !== 'local' ? row.provider : null,
      model: row?.model ?? null,
      routing: row?.routing ?? 'local_first',
      keyHint,
      lastTestedAt: row?.lastTestedAt?.toISOString() ?? null,
      lastTestError: row?.lastTestError ?? null,
      defaultModels: DEFAULT_FALLBACK_MODELS,
    };
  }
}
