import type { Database, VoiceSetting } from '@smartchat/database';
import { ActorType as DbActorType, toJson } from '@smartchat/database';
import {
  Permission,
  type TenantContext,
  type VoiceLanguage,
  type VoicePhraseKey,
  type VoiceSettingsDto,
} from '@smartchat/types';
import type { UpdateVoiceSettingsInput } from '@smartchat/validation';
import type { EntitlementService } from '../billing/entitlements.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { DEFAULT_PHRASES, readPhrases, resolvedPhrases } from './phrases.js';

/**
 * Calling as an account configures it for one website: whether the button is there, how long
 * the team rings, whether the AI picks up, which voices it speaks with and what it says.
 *
 * One row per website, created on first read with the defaults. The plan is checked when the
 * switch is turned on; everything else can be set on any plan, so a website is ready the moment
 * it upgrades.
 */

export interface VoiceSettingsServiceOptions {
  db: Database;
  entitlements: EntitlementService;
}

export interface VoiceSettingsView extends VoiceSettingsDto {
  /** Every phrase with its effective text, for the settings page to show and edit. */
  resolvedPhrases: Record<VoicePhraseKey, Record<VoiceLanguage, string>>;
  /** The defaults, so the page can show what "reset" goes back to while an override is set. */
  defaultPhrases: Record<VoicePhraseKey, Record<VoiceLanguage, string>>;
  usage: { minutesUsed: number; minutesLimit: number | null };
}

/** The row with its JSON column read into the typed shape. */
export type VoiceSettings = Omit<VoiceSetting, 'phrases'> & {
  phrases: ReturnType<typeof readPhrases>;
  defaultLanguage: VoiceLanguage;
};

export class VoiceSettingsService {
  private readonly audit: AuditRepository;

  constructor(private readonly options: VoiceSettingsServiceOptions) {
    this.audit = new AuditRepository(options.db);
  }

  /** The row for a website, created with the defaults if this is the first time anyone asked. */
  async forProperty(accountId: string, propertyId: string): Promise<VoiceSettings> {
    const existing = await this.options.db.voiceSetting.findUnique({
      where: { accountId_propertyId: { accountId, propertyId } },
    });
    const row =
      existing ?? (await this.options.db.voiceSetting.create({ data: { accountId, propertyId } }));
    return typed(row);
  }

  /**
   * Whether a visitor of this website may call right now: the switch is on and the plan includes
   * it. The minutes allowance is checked when the call starts, not here, so the button does not
   * flicker on the monthly boundary.
   */
  async callingEnabled(accountId: string, propertyId: string): Promise<boolean> {
    const settings = await this.options.db.voiceSetting.findUnique({
      where: { accountId_propertyId: { accountId, propertyId } },
      select: { enabled: true },
    });
    if (!settings?.enabled) return false;
    return this.options.entitlements.hasFeature(accountId, 'voice');
  }

  async get(context: TenantContext, propertyId: string): Promise<VoiceSettingsView> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const settings = await this.forProperty(context.accountId, propertyId);
    return this.view(context.accountId, settings);
  }

  async update(
    context: TenantContext,
    propertyId: string,
    input: UpdateVoiceSettingsInput,
  ): Promise<VoiceSettingsView> {
    requirePermission(context, Permission.PROPERTY_UPDATE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    if (input.enabled === true) {
      await this.options.entitlements.assertFeature(context.accountId, 'voice');
    }

    const current = await this.forProperty(context.accountId, propertyId);
    const data = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.ringSeconds !== undefined ? { ringSeconds: input.ringSeconds } : {}),
      ...(input.aiAnswers !== undefined ? { aiAnswers: input.aiAnswers } : {}),
      ...(input.aiMaxSeconds !== undefined ? { aiMaxSeconds: input.aiMaxSeconds } : {}),
      ...(input.defaultLanguage !== undefined ? { defaultLanguage: input.defaultLanguage } : {}),
      ...(input.voiceEn !== undefined ? { voiceEn: input.voiceEn } : {}),
      ...(input.voiceBn !== undefined ? { voiceBn: input.voiceBn } : {}),
      ...(input.voiceBnSpeaker !== undefined ? { voiceBnSpeaker: input.voiceBnSpeaker } : {}),
      // Overrides are replaced whole: the page sends every phrase it shows, and an empty entry
      // means "back to the default", which is exactly what dropping it from the bag does.
      ...(input.phrases !== undefined ? { phrases: toJson(readPhrases(input.phrases)) } : {}),
    };
    const saved = await this.options.db.voiceSetting.update({ where: { id: current.id }, data });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'voice.settings.updated',
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { changed: Object.keys(data), enabled: saved.enabled },
    });
    return this.view(context.accountId, typed(saved));
  }

  private async view(accountId: string, settings: VoiceSettings): Promise<VoiceSettingsView> {
    const [planIncludesVoice, usage] = await Promise.all([
      this.options.entitlements.hasFeature(accountId, 'voice'),
      this.options.entitlements.voiceMinutesAllowance(accountId),
    ]);
    return {
      enabled: settings.enabled,
      ringSeconds: settings.ringSeconds,
      aiAnswers: settings.aiAnswers,
      aiMaxSeconds: settings.aiMaxSeconds,
      defaultLanguage: settings.defaultLanguage,
      voiceEn: settings.voiceEn,
      voiceBn: settings.voiceBn,
      voiceBnSpeaker: settings.voiceBnSpeaker,
      phrases: settings.phrases,
      planIncludesVoice,
      resolvedPhrases: resolvedPhrases(settings.phrases),
      defaultPhrases: DEFAULT_PHRASES,
      usage: { minutesUsed: usage.used, minutesLimit: usage.limit },
    };
  }
}

function typed(row: VoiceSetting): VoiceSettings {
  return {
    ...row,
    phrases: readPhrases(row.phrases),
    defaultLanguage: row.defaultLanguage === 'bn' ? 'bn' : 'en',
  };
}
