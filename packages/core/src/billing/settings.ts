import type { Database } from '@smartchat/database';
import { SecretBox } from '../crypto/secretbox.js';

/**
 * Platform-wide settings the operator edits in the console.
 *
 * A closed list of keys, so a typo is a compile error and the console cannot invent settings the
 * code does not read. Secrets are sealed with `SecretBox` before they reach the row and opened
 * only here; a read of a sealed value by anything else gets the ciphertext, which is the point.
 */

export const PlatformSettingKey = {
  STRIPE_PUBLISHABLE_KEY: 'stripe.publishable_key',
  STRIPE_SECRET_KEY: 'stripe.secret_key',
  STRIPE_WEBHOOK_SECRET: 'stripe.webhook_secret',
  /** Days a past-due subscription keeps working before the dashboard locks. */
  BILLING_GRACE_DAYS: 'billing.grace_days',
  /** Where custom-plan enquiries go. Falls back to MAIL_FROM_ADDRESS when unset. */
  BILLING_CONTACT_EMAIL: 'billing.contact_email',
} as const;
export type PlatformSettingKey = (typeof PlatformSettingKey)[keyof typeof PlatformSettingKey];

const SECRET_KEYS: ReadonlySet<PlatformSettingKey> = new Set([
  PlatformSettingKey.STRIPE_SECRET_KEY,
  PlatformSettingKey.STRIPE_WEBHOOK_SECRET,
]);

export interface StripeConfiguration {
  publishableKey: string;
  secretKey: string;
  webhookSecret: string | null;
  /** Read off the key prefix: `sk_test_` is test mode. Shown in the console so nobody wonders. */
  testMode: boolean;
}

export class PlatformSettingsService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: Database,
    encryptionKeyHex: string,
  ) {
    this.box = new SecretBox(encryptionKeyHex);
  }

  async get(key: PlatformSettingKey): Promise<string | null> {
    const row = await this.db.platformSetting.findUnique({ where: { key } });
    if (!row) return null;
    if (!row.encrypted) return row.value;
    // A value sealed under a previous key opens to an error, not to garbage. The caller sees
    // "not configured" and the console says the secret must be re-entered.
    try {
      return this.box.open(row.value);
    } catch {
      return null;
    }
  }

  async set(key: PlatformSettingKey, value: string | null, adminId: string | null): Promise<void> {
    if (value === null || value === '') {
      await this.db.platformSetting.deleteMany({ where: { key } });
      return;
    }
    const encrypted = SECRET_KEYS.has(key);
    const stored = encrypted ? this.box.seal(value) : value;
    await this.db.platformSetting.upsert({
      where: { key },
      create: { key, value: stored, encrypted, updatedByAdminId: adminId },
      update: { value: stored, encrypted, updatedByAdminId: adminId },
    });
  }

  /** Whether a secret is set, without returning it. For the console's "•••• configured" state. */
  async has(key: PlatformSettingKey): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async stripe(): Promise<StripeConfiguration | null> {
    const [publishableKey, secretKey, webhookSecret] = await Promise.all([
      this.get(PlatformSettingKey.STRIPE_PUBLISHABLE_KEY),
      this.get(PlatformSettingKey.STRIPE_SECRET_KEY),
      this.get(PlatformSettingKey.STRIPE_WEBHOOK_SECRET),
    ]);
    if (!publishableKey || !secretKey) return null;
    return {
      publishableKey,
      secretKey,
      webhookSecret,
      testMode: secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_'),
    };
  }

  graceDays(): Promise<number> {
    return readGraceDays(this.db);
  }
}

/**
 * The grace window, readable without the encryption key: it is not a secret, and the worker,
 * which has no Stripe business, reads it without being handed the key to things that are.
 */
export async function readGraceDays(db: Database): Promise<number> {
  const row = await db.platformSetting.findUnique({
    where: { key: PlatformSettingKey.BILLING_GRACE_DAYS },
  });
  const parsed = row === null || row.encrypted ? NaN : Number(row.value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 60 ? parsed : 3;
}
