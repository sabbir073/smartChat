'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/billing';

/**
 * The operator's side of billing: Stripe keys, the plans on sale, and enquiries.
 *
 * Styled like the rest of the console - dark, plain, no opinions. Secrets are write-only: the
 * page shows whether one is stored, never what it is.
 */

interface SettingsView {
  stripe: {
    publishableKey: string | null;
    secretKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    testMode: boolean | null;
  };
  graceDays: number;
  contactEmail: string | null;
  webhookUrl: string;
}

export interface PlanAdmin {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  description: string | null;
  monthlyPriceCents: number;
  annualPriceCents: number;
  currency: string;
  maxProperties: number | null;
  maxMembers: number | null;
  aiAgent: boolean;
  integrations: boolean;
  removeBranding: boolean;
  isContactSales: boolean;
  isPublic: boolean;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  stripeProductId: string | null;
  stripeMonthlyPriceId: string | null;
  stripeAnnualPriceId: string | null;
  subscribers: number;
  stripeSynced: boolean;
}

interface Enquiry {
  id: string;
  account: { id: string; name: string; slug: string };
  name: string;
  email: string;
  message: string;
  wants: Record<string, unknown>;
  handledAt: string | null;
  createdAt: string;
}

const INPUT =
  'h-9 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 text-sm text-ink-inverted placeholder:text-ink-inverted/30';
const BUTTON =
  'h-9 rounded-[var(--radius-control)] border border-ink-inverted/20 px-3 text-[13px] font-medium disabled:opacity-50';
const PRIMARY =
  'h-9 rounded-[var(--radius-control)] bg-ink-inverted px-3 text-[13px] font-medium text-ink disabled:opacity-50';
const PANEL = 'rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 p-4';

function describe(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function BillingTab({ onError }: { onError: (message: string | null) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [plans, setPlans] = useState<PlanAdmin[]>([]);
  const [enquiries, setEnquiries] = useState<Enquiry[]>([]);
  const [editing, setEditing] = useState<PlanAdmin | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p, e] = await Promise.all([
        api.get<SettingsView>('/platform/billing/settings'),
        api.get<{ plans: PlanAdmin[] }>('/platform/billing/plans'),
        api.get<{ enquiries: Enquiry[] }>('/platform/billing/enquiries'),
      ]);
      setSettings(s.data);
      setPlans(p.data.plans);
      setEnquiries(e.data.enquiries);
      onError(null);
    } catch (error) {
      onError(describe(error, 'Billing settings could not be loaded.'));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return <p className="text-sm text-ink-inverted/50">Loading…</p>;

  return (
    <div className="space-y-8">
      {notice && (
        <p className="rounded-[var(--radius-control)] bg-success/20 px-3 py-2 text-[13px] text-success">
          {notice}
        </p>
      )}

      <StripeSettings
        settings={settings}
        onSaved={(view, message) => {
          setSettings(view);
          setNotice(message);
          onError(null);
        }}
        onError={onError}
      />

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold">Plans</h2>
            <p className="text-[13px] text-ink-inverted/60">
              What accounts can buy. Changing a price here creates a new Stripe price; existing
              subscribers keep what they were sold at until they change plan.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={!settings.stripe.secretKeyConfigured}
              title={
                settings.stripe.secretKeyConfigured ? undefined : 'Enter the Stripe keys first'
              }
              onClick={() => {
                void api
                  .post<{
                    results: {
                      plan: PlanAdmin;
                      stripe: { status: string; error: string | null };
                    }[];
                  }>('/platform/billing/plans/sync')
                  .then((result) => {
                    const failed = result.data.results.filter((r) => r.stripe.status === 'failed');
                    setNotice(
                      failed.length === 0
                        ? `Synced ${result.data.results.length} plan${result.data.results.length === 1 ? '' : 's'} with Stripe.`
                        : `Stripe refused ${failed.map((r) => `${r.plan.name}: ${r.stripe.error}`).join('; ')}`,
                    );
                    return load();
                  })
                  .catch((error) => onError(describe(error, 'Could not sync with Stripe.')));
              }}
            >
              Sync with Stripe
            </button>
            <button type="button" className={PRIMARY} onClick={() => setEditing('new')}>
              New plan
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={`${PANEL} flex flex-wrap items-start justify-between gap-3`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                  {plan.name}
                  <span className="font-mono text-[12px] font-normal text-ink-inverted/50">
                    {plan.key}
                  </span>
                  {plan.isDefault && <Tag>default</Tag>}
                  {!plan.isActive && <Tag tone="danger">retired</Tag>}
                  {!plan.isPublic && <Tag>hidden</Tag>}
                  {plan.isContactSales && <Tag>contact us</Tag>}
                  {plan.isActive &&
                    !plan.isContactSales &&
                    !plan.stripeSynced &&
                    (plan.monthlyPriceCents > 0 || plan.annualPriceCents > 0) && (
                      <Tag tone="warning">not in Stripe yet</Tag>
                    )}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-inverted/60">
                  {plan.isContactSales
                    ? 'Custom pricing'
                    : `${formatMoney(plan.monthlyPriceCents, plan.currency)}/month · ${formatMoney(plan.annualPriceCents, plan.currency)}/year`}
                  {' · '}
                  {plan.maxProperties ?? '∞'} websites · {plan.maxMembers ?? '∞'} members
                  {plan.aiAgent ? ' · AI agent' : ''}
                  {plan.integrations ? ' · integrations' : ''}
                  {plan.removeBranding ? ' · no branding' : ''}
                  {' · '}
                  {plan.subscribers} account{plan.subscribers === 1 ? '' : 's'}
                </p>
              </div>
              <button type="button" className={BUTTON} onClick={() => setEditing(plan)}>
                Edit
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-[17px] font-semibold">Custom plan enquiries</h2>
        <p className="mb-3 text-[13px] text-ink-inverted/60">
          Sent from the Billing page. Each one was also emailed to{' '}
          {settings.contactEmail ?? 'the sending address'}.
        </p>
        {enquiries.length === 0 ? (
          <p className="text-sm text-ink-inverted/50">Nothing open.</p>
        ) : (
          <div className="space-y-2">
            {enquiries.map((enquiry) => (
              <div key={enquiry.id} className={PANEL}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">
                      {enquiry.account.name}{' '}
                      <span className="text-[13px] font-normal text-ink-inverted/50">
                        · {enquiry.name} &lt;{enquiry.email}&gt; · {formatDate(enquiry.createdAt)}
                      </span>
                    </p>
                    {Object.keys(enquiry.wants).length > 0 && (
                      <p className="mt-0.5 text-[13px] text-ink-inverted/60">
                        Wants:{' '}
                        {Object.entries(enquiry.wants)
                          .map(([key, value]) => `${key} ${String(value)}`)
                          .join(', ')}
                      </p>
                    )}
                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink-inverted/80">
                      {enquiry.message}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() => {
                      void api
                        .post(`/platform/billing/enquiries/${enquiry.id}/handled`)
                        .then(() => load())
                        .catch((error) => onError(describe(error, 'Could not update that.')));
                    }}
                  >
                    Mark handled
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <PlanEditor
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function Tag({ children, tone }: { children: string; tone?: 'danger' | 'warning' }) {
  const colour =
    tone === 'danger'
      ? 'bg-danger/30 text-danger-soft'
      : tone === 'warning'
        ? 'bg-warning/30 text-warning'
        : 'bg-ink-inverted/15 text-ink-inverted/80';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colour}`}>{children}</span>
  );
}

function StripeSettings({
  settings,
  onSaved,
  onError,
}: {
  settings: SettingsView;
  onSaved: (view: SettingsView, message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [publishable, setPublishable] = useState(settings.stripe.publishableKey ?? '');
  const [secret, setSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [graceDays, setGraceDays] = useState(String(settings.graceDays));
  const [contactEmail, setContactEmail] = useState(settings.contactEmail ?? '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        stripePublishableKey: publishable.trim() || null,
        graceDays: Number(graceDays),
        contactEmail: contactEmail.trim() || null,
      };
      // Secrets are sent only when typed: an empty field means "leave it as it is".
      if (secret.trim()) body['stripeSecretKey'] = secret.trim();
      if (webhookSecret.trim()) body['stripeWebhookSecret'] = webhookSecret.trim();
      const result = await api.patch<SettingsView>('/platform/billing/settings', body);
      setSecret('');
      setWebhookSecret('');
      onSaved(result.data, 'Billing settings saved.');
    } catch (error) {
      onError(describe(error, 'Could not save the settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ livemode: boolean; accountName: string | null }>(
        '/platform/billing/settings/test',
      );
      setTestResult(
        `Connected to ${result.data.accountName ?? 'Stripe'} in ${result.data.livemode ? 'LIVE' : 'test'} mode.`,
      );
    } catch (error) {
      setTestResult(describe(error, 'Stripe did not answer.'));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className={PANEL}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold">
            Stripe {settings.stripe.testMode === true && <Tag tone="warning">test mode</Tag>}
            {settings.stripe.testMode === false && <Tag>live</Tag>}
          </h2>
          <p className="text-[13px] text-ink-inverted/60">
            Keys from the Stripe dashboard. The secret key and the webhook secret are stored
            encrypted and never shown again.
          </p>
        </div>
        <button
          type="button"
          className={BUTTON}
          disabled={testing || !settings.stripe.secretKeyConfigured}
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {testResult && <p className="mt-2 text-[13px] text-ink-inverted/80">{testResult}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Publishable key</span>
          <input
            className={`${INPUT} mt-1 font-mono`}
            value={publishable}
            onChange={(e) => setPublishable(e.target.value)}
            placeholder="pk_test_…"
          />
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">
            Secret key {settings.stripe.secretKeyConfigured ? '· stored' : '· not set'}
          </span>
          <input
            className={`${INPUT} mt-1 font-mono`}
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              settings.stripe.secretKeyConfigured
                ? 'Leave blank to keep the stored key'
                : 'sk_test_…'
            }
          />
        </label>
        <label className="block text-[13px] sm:col-span-2">
          <span className="text-ink-inverted/70">
            Webhook signing secret{' '}
            {settings.stripe.webhookSecretConfigured ? '· stored' : '· not set'}
          </span>
          <input
            className={`${INPUT} mt-1 font-mono`}
            type="password"
            autoComplete="off"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={
              settings.stripe.webhookSecretConfigured
                ? 'Leave blank to keep the stored secret'
                : 'whsec_…'
            }
          />
          <span className="mt-1 block text-[12px] text-ink-inverted/50">
            In Stripe, add a webhook endpoint for{' '}
            <code className="rounded bg-ink-inverted/10 px-1 py-0.5 font-mono">
              {settings.webhookUrl}
            </code>{' '}
            with the events <code>checkout.session.completed</code>,{' '}
            <code>customer.subscription.*</code> and <code>invoice.*</code>, then paste its signing
            secret here.
          </span>
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Grace period after a failed payment (days)</span>
          <input
            className={`${INPUT} mt-1`}
            type="number"
            min={0}
            max={60}
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
          />
          <span className="mt-1 block text-[12px] text-ink-inverted/50">
            The dashboard stays usable for this long while Stripe retries the card, then locks.
          </span>
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Custom plan enquiries go to</span>
          <input
            className={`${INPUT} mt-1`}
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="sales@example.com"
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="submit" className={PRIMARY} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

/** Escape closes an overlay, the way every dialog in the product does. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function PlanEditor({
  plan,
  onClose,
  onSaved,
  onError,
}: {
  plan: PlanAdmin | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    key: plan?.key ?? '',
    name: plan?.name ?? '',
    tagline: plan?.tagline ?? '',
    description: plan?.description ?? '',
    monthly: plan ? (plan.monthlyPriceCents / 100).toString() : '0',
    annual: plan ? (plan.annualPriceCents / 100).toString() : '0',
    currency: plan?.currency ?? 'usd',
    maxProperties: plan ? (plan.maxProperties === null ? '' : String(plan.maxProperties)) : '1',
    maxMembers: plan ? (plan.maxMembers === null ? '' : String(plan.maxMembers)) : '1',
    aiAgent: plan?.aiAgent ?? false,
    integrations: plan?.integrations ?? false,
    removeBranding: plan?.removeBranding ?? false,
    isContactSales: plan?.isContactSales ?? false,
    isPublic: plan?.isPublic ?? true,
    isDefault: plan?.isDefault ?? false,
    isActive: plan?.isActive ?? true,
    sortOrder: String(plan?.sortOrder ?? 0),
  });
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEscape(onClose);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});
    const toCents = (value: string) => Math.round(Number(value || '0') * 100);
    const toLimit = (value: string) => (value.trim() === '' ? null : Number(value));
    const body = {
      ...(plan ? {} : { key: form.key }),
      name: form.name,
      tagline: form.tagline.trim() || null,
      description: form.description.trim() || null,
      monthlyPriceCents: toCents(form.monthly),
      annualPriceCents: toCents(form.annual),
      currency: form.currency,
      maxProperties: toLimit(form.maxProperties),
      maxMembers: toLimit(form.maxMembers),
      aiAgent: form.aiAgent,
      integrations: form.integrations,
      removeBranding: form.removeBranding,
      isContactSales: form.isContactSales,
      isPublic: form.isPublic,
      isDefault: form.isDefault,
      isActive: form.isActive,
      sortOrder: Number(form.sortOrder || '0'),
    };
    try {
      const result = plan
        ? await api.patch<{ plan: PlanAdmin; stripe: { status: string; error: string | null } }>(
            `/platform/billing/plans/${plan.id}`,
            body,
          )
        : await api.post<{ plan: PlanAdmin; stripe: { status: string; error: string | null } }>(
            '/platform/billing/plans',
            body,
          );
      const { stripe } = result.data;
      onSaved(
        stripe.status === 'failed'
          ? `${result.data.plan.name} saved, but Stripe refused it: ${stripe.error}. Fix the keys and press "Sync with Stripe".`
          : stripe.status === 'synced'
            ? `${result.data.plan.name} saved and synced with Stripe.`
            : `${result.data.plan.name} saved.`,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors());
        onError(error.message);
      } else {
        onError('Could not save the plan.');
      }
    } finally {
      setSaving(false);
    }
  }

  const text = (label: string, key: keyof typeof form, extra: Record<string, unknown> = {}) => (
    <label className="block text-[13px]">
      <span className="text-ink-inverted/70">{label}</span>
      <input
        className={`${INPUT} mt-1`}
        value={String(form[key])}
        onChange={(e) => set(key, e.target.value as never)}
        {...extra}
      />
      {fieldErrors[key] && (
        <span className="mt-1 block text-[12px] text-danger-soft">{fieldErrors[key]}</span>
      )}
    </label>
  );
  const check = (label: string, key: keyof typeof form, hint?: string) => (
    <label className="flex items-start gap-2 text-[13px]">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={Boolean(form[key])}
        onChange={(e) => set(key, e.target.checked as never)}
      />
      <span>
        {label}
        {hint && <span className="block text-[12px] text-ink-inverted/50">{hint}</span>}
      </span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/60 p-6">
      <form
        onSubmit={(event) => void save(event)}
        className="my-auto w-full max-w-2xl rounded-[var(--radius-card)] border border-ink-inverted/20 bg-ink p-5"
      >
        <h2 className="text-[17px] font-semibold">{plan ? `Edit ${plan.name}` : 'New plan'}</h2>
        <p className="mt-1 text-[13px] text-ink-inverted/60">
          Prices are whole units of the currency (20 means $20). Leave a limit blank for unlimited.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {!plan &&
            text('Key (cannot change later)', 'key', { placeholder: 'starter', required: true })}
          {text('Name', 'name', { required: true })}
          {text('Tagline', 'tagline', { placeholder: 'For small teams' })}
          {text('Currency', 'currency', { maxLength: 3 })}
          {text('Monthly price', 'monthly', { type: 'number', min: 0, step: '0.01' })}
          {text('Yearly price', 'annual', { type: 'number', min: 0, step: '0.01' })}
          {text('Max websites', 'maxProperties', {
            type: 'number',
            min: 1,
            placeholder: 'unlimited',
          })}
          {text('Max team members', 'maxMembers', {
            type: 'number',
            min: 1,
            placeholder: 'unlimited',
          })}
          {text('Sort order', 'sortOrder', { type: 'number', min: 0 })}
          <label className="block text-[13px] sm:col-span-2">
            <span className="text-ink-inverted/70">Description</span>
            <textarea
              rows={2}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 py-2 text-sm text-ink-inverted"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {check('AI agent', 'aiAgent')}
          {check('API keys & webhooks', 'integrations')}
          {check('Remove widget branding', 'removeBranding')}
          {check(
            'Contact us instead of checkout',
            'isContactSales',
            'Prices are ignored; the button opens an enquiry form.',
          )}
          {check(
            'Shown on the Billing page',
            'isPublic',
            'Hidden plans can still be assigned by hand.',
          )}
          {check(
            'Default for new accounts',
            'isDefault',
            'Must be free; new accounts have no card.',
          )}
          {check(
            'Active',
            'isActive',
            'Retired plans keep their subscribers but cannot be chosen.',
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] text-ink-inverted/70"
          >
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={saving}>
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- one account ---------------------------------------------------------------

interface AccountBillingView {
  subscription: {
    status: string;
    provider: string;
    interval: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    pastDueSince: string | null;
    lockedAt: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    note: string | null;
  };
  plan: {
    id: string;
    key: string;
    name: string;
    maxProperties: number | null;
    maxMembers: number | null;
  };
  usage: { properties: number; members: number };
  locked: { locked: boolean; reason: string | null };
  invoices: {
    id: string;
    number: string | null;
    status: string;
    amountDueCents: number;
    amountPaidCents: number;
    currency: string;
    issuedAt: string | null;
    hostedInvoiceUrl: string | null;
  }[];
}

export function AccountBillingPanel({
  account,
  onClose,
  onError,
}: {
  account: { id: string; name: string };
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [view, setView] = useState<AccountBillingView | null>(null);
  const [plans, setPlans] = useState<PlanAdmin[]>([]);
  const [planKey, setPlanKey] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(onClose);

  const load = useCallback(async () => {
    try {
      const [billing, list] = await Promise.all([
        api.get<AccountBillingView>(`/platform/accounts/${account.id}/billing`),
        api.get<{ plans: PlanAdmin[] }>('/platform/billing/plans'),
      ]);
      setView(billing.data);
      setPlans(list.data.plans.filter((plan) => plan.isActive));
      setPlanKey(billing.data.plan.key);
      setNote(billing.data.subscription.note ?? '');
    } catch (error) {
      onError(describe(error, 'Could not load billing for that account.'));
    }
  }, [account.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    setSaving(true);
    try {
      const result = await api.put<AccountBillingView>(`/platform/accounts/${account.id}/plan`, {
        planKey,
        note: note.trim() || null,
      });
      setView(result.data);
      onError(null);
    } catch (error) {
      onError(describe(error, 'Could not change the plan.'));
    } finally {
      setSaving(false);
    }
  }

  const stripeManaged =
    view?.subscription.provider === 'stripe' && view.subscription.stripeSubscriptionId !== null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/60 p-6">
      <div className="my-auto w-full max-w-xl rounded-[var(--radius-card)] border border-ink-inverted/20 bg-ink p-5">
        <h2 className="text-[17px] font-semibold">Billing · {account.name}</h2>
        {!view ? (
          <p className="mt-3 text-sm text-ink-inverted/50">Loading…</p>
        ) : (
          <>
            <p className="mt-1.5 text-[13px] text-ink-inverted/60">
              On <strong className="text-ink-inverted">{view.plan.name}</strong> ·{' '}
              {view.subscription.status.replace('_', ' ')} · {view.subscription.provider}
              {view.subscription.currentPeriodEnd &&
                ` · renews ${formatDate(view.subscription.currentPeriodEnd)}`}
              {' · '}
              {view.usage.properties}/{view.plan.maxProperties ?? '∞'} websites ·{' '}
              {view.usage.members}/{view.plan.maxMembers ?? '∞'} members
              {view.locked.locked && (
                <span className="text-danger-soft"> · LOCKED ({view.locked.reason})</span>
              )}
            </p>
            {view.subscription.stripeCustomerId && (
              <p className="mt-1 font-mono text-[12px] text-ink-inverted/40">
                {view.subscription.stripeCustomerId}
                {view.subscription.stripeSubscriptionId &&
                  ` · ${view.subscription.stripeSubscriptionId}`}
              </p>
            )}

            <div className="mt-4 rounded-[var(--radius-control)] border border-ink-inverted/10 p-3">
              <p className="text-[13px] font-medium">Set plan by hand</p>
              {stripeManaged ? (
                <p className="mt-1 text-[13px] text-ink-inverted/60">
                  This account pays through Stripe. Change or cancel its subscription in Stripe; it
                  falls back to the default plan when the subscription ends, and can be set by hand
                  after that.
                </p>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <select
                    className={INPUT}
                    value={planKey}
                    onChange={(e) => setPlanKey(e.target.value)}
                  >
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.key}>
                        {plan.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={INPUT}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Why (shown only here)"
                  />
                  <button
                    type="button"
                    className={PRIMARY}
                    disabled={saving}
                    onClick={() => void apply()}
                  >
                    {saving ? 'Saving…' : 'Apply'}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-4">
              <p className="text-[13px] font-medium">Invoices</p>
              {view.invoices.length === 0 ? (
                <p className="mt-1 text-[13px] text-ink-inverted/50">None.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-[13px]">
                  {view.invoices.map((invoice) => (
                    <li key={invoice.id} className="flex flex-wrap gap-2">
                      <span className="font-mono">{invoice.number ?? invoice.id.slice(0, 8)}</span>
                      <span>
                        {formatMoney(
                          invoice.status === 'paid'
                            ? invoice.amountPaidCents
                            : invoice.amountDueCents,
                          invoice.currency,
                        )}
                      </span>
                      <span className="text-ink-inverted/60">{invoice.status}</span>
                      <span className="text-ink-inverted/40">{formatDate(invoice.issuedAt)}</span>
                      {invoice.hostedInvoiceUrl && (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-ring hover:underline"
                        >
                          open
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] text-ink-inverted/70"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
