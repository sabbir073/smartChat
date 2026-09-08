'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import {
  formatDate,
  formatMoney,
  lockMessage,
  useBilling,
  type EntitlementsDto,
  type LockReason,
} from '@/lib/billing';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Modal,
  Spinner,
  TextInput,
  cn,
  useToast,
} from '@/components/ui';

interface PlanCard {
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
  sortOrder: number;
  purchasable: boolean;
}

interface InvoiceView {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  planName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

interface BillingOverview {
  entitlements: {
    plan: EntitlementsDto['plan'];
    subscription: {
      status: string;
      interval: 'month' | 'year';
      provider: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      pastDueSince: string | null;
      lockedAt: string | null;
    };
    usage: { properties: number; members: number };
    lock: { locked: boolean; reason: LockReason | null; graceEndsAt: string | null };
  };
  usage: { properties: number; members: number };
  plans: PlanCard[];
  invoices: InvoiceView[];
  canManagePayment: boolean;
  checkoutAvailable: boolean;
  testMode: boolean;
}

type Interval = 'month' | 'year';

const STATUS_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }
> = {
  none: { label: 'No subscription', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Payment failed', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'danger' },
  canceled: { label: 'Ended', tone: 'danger' },
  incomplete: { label: 'Payment pending', tone: 'warning' },
  incomplete_expired: { label: 'Payment failed', tone: 'danger' },
};

const INVOICE_TONE: Record<InvoiceView['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  open: 'warning',
  paid: 'success',
  uncollectible: 'danger',
  void: 'neutral',
};

function limit(value: number | null, noun: string): string {
  if (value === null) return `Unlimited ${noun}s`;
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const { can } = useAuth();
  const billing = useBilling();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const canManage = can('billing:manage');

  const overview = useResource<BillingOverview>(
    (signal) => api.get<BillingOverview>('/billing', { signal }).then((r) => r.data),
    [],
  );

  const [interval, setInterval] = useState<Interval>('month');
  const [working, setWorking] = useState<string | null>(null);
  const [enquiryOpen, setEnquiryOpen] = useState(false);

  // Back from Stripe. The webhook usually lands before the browser does; reload so the page shows
  // the new plan, and say something either way.
  const checkout = params.get('checkout');
  useEffect(() => {
    if (!checkout) return;
    if (checkout === 'success') toast.success('Thanks - your plan is being activated.');
    if (checkout === 'cancelled') toast.info('Checkout cancelled. Nothing was charged.');
    router.replace('/app/billing');
    const timer = window.setTimeout(() => {
      overview.reload();
      void billing.reload();
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

  useEffect(() => {
    const current = overview.data?.entitlements.subscription.interval;
    if (current === 'year') setInterval('year');
  }, [overview.data?.entitlements.subscription.interval]);

  async function choose(plan: PlanCard) {
    setWorking(plan.key);
    try {
      const result = await api.post<{ url: string } | { changed: true }>('/billing/checkout', {
        planKey: plan.key,
        interval,
      });
      if ('url' in result.data) {
        window.location.assign(result.data.url);
        return;
      }
      toast.success(`You're now on ${plan.name}. The change is prorated on your next invoice.`);
      overview.reload();
      await billing.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start checkout.');
    } finally {
      setWorking(null);
    }
  }

  async function openPortal() {
    setWorking('portal');
    try {
      const result = await api.post<{ url: string }>('/billing/portal');
      window.location.assign(result.data.url);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not open the payment portal.');
      setWorking(null);
    }
  }

  if (overview.loading && !overview.data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6 text-ink-subtle" />
      </div>
    );
  }
  if (overview.error || !overview.data) {
    return (
      <Alert tone="danger" title="Billing could not be loaded">
        {overview.error?.message}
      </Alert>
    );
  }

  const data = overview.data;
  const { plan, subscription, lock } = data.entitlements;
  const status = STATUS_LABEL[subscription.status] ?? {
    label: subscription.status,
    tone: 'neutral' as const,
  };
  const priced = data.plans.some((entry) => entry.annualPriceCents > 0);

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan, what it includes, and your invoices."
        action={
          data.canManagePayment && canManage ? (
            <Button
              variant="secondary"
              loading={working === 'portal'}
              onClick={() => void openPortal()}
            >
              Manage payment method
            </Button>
          ) : undefined
        }
      />

      {data.testMode && (
        <Alert tone="info" className="mb-4" title="Payments are in test mode">
          Cards are not really charged. Use Stripe&apos;s test card 4242 4242 4242 4242 with any
          future date and any CVC.
        </Alert>
      )}

      {lock.locked && lock.reason && (
        <Alert tone="danger" className="mb-4" title="Your dashboard is locked">
          {lockMessage(lock.reason)}
          {lock.reason === 'over_limit' && (
            <>
              {' '}
              You have {data.usage.properties} website{data.usage.properties === 1 ? '' : 's'} and{' '}
              {data.usage.members} team member{data.usage.members === 1 ? '' : 's'}; {plan.name}{' '}
              includes {limit(plan.maxProperties, 'website').toLowerCase()} and{' '}
              {limit(plan.maxMembers, 'team member').toLowerCase()}.
            </>
          )}
        </Alert>
      )}

      {subscription.status === 'past_due' && !lock.locked && (
        <Alert tone="warning" className="mb-4" title="Your last payment failed">
          We&apos;ll keep trying your card.{' '}
          {lock.graceEndsAt &&
            `If it isn't sorted by ${formatDate(lock.graceEndsAt)}, the dashboard will be locked until it is.`}{' '}
          Update your payment method to fix it now.
        </Alert>
      )}

      {!canManage && (
        <Alert tone="info" className="mb-4">
          Only owners and admins can change the plan or the payment method.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Current plan: {plan.name}
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </span>
            }
            description={
              subscription.status === 'active' && subscription.currentPeriodEnd
                ? subscription.cancelAtPeriodEnd
                  ? `Ends on ${formatDate(subscription.currentPeriodEnd)}. Your account returns to the free plan after that.`
                  : `Renews on ${formatDate(subscription.currentPeriodEnd)}, billed ${subscription.interval === 'year' ? 'yearly' : 'monthly'}.`
                : plan.isContactSales
                  ? 'A custom arrangement.'
                  : 'No card on file.'
            }
          />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Usage label="Websites" used={data.usage.properties} max={plan.maxProperties} />
              <Usage label="Team members" used={data.usage.members} max={plan.maxMembers} />
              <div>
                <dt className="text-[13px] text-ink-muted">Features</dt>
                <dd className="mt-1 space-y-0.5 text-sm text-ink">
                  <Feature on={plan.aiAgent}>AI agent</Feature>
                  <Feature on={plan.integrations}>API keys &amp; webhooks</Feature>
                  <Feature on={plan.removeBranding}>Remove widget branding</Feature>
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Need something bigger?"
            description="Tell us what you need and we'll put a plan together."
          />
          <CardBody>
            <Button variant="secondary" fullWidth onClick={() => setEnquiryOpen(true)}>
              Contact us about a custom plan
            </Button>
          </CardBody>
        </Card>
      </div>

      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-ink">Plans</h2>
          {priced && (
            <div
              role="group"
              aria-label="Billing period"
              className="inline-flex rounded-full border border-border bg-surface p-0.5 text-[13px] font-medium"
            >
              {(['month', 'year'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setInterval(entry)}
                  aria-pressed={interval === entry}
                  className={cn(
                    'rounded-full px-3 py-1 transition-colors',
                    interval === entry
                      ? 'bg-brand text-ink-inverted'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {entry === 'month' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
          )}
        </div>

        {!data.checkoutAvailable && (
          <Alert tone="info" className="mb-4">
            Paid plans are not available yet on this installation - payments have not been set up.
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {data.plans.map((entry) => {
            const current = entry.id === plan.id;
            const price = interval === 'year' ? entry.annualPriceCents : entry.monthlyPriceCents;
            const perMonth =
              interval === 'year'
                ? Math.round(entry.annualPriceCents / 12)
                : entry.monthlyPriceCents;
            const free =
              !entry.isContactSales &&
              entry.monthlyPriceCents === 0 &&
              entry.annualPriceCents === 0;
            const soldThisWay =
              interval === 'year' ? entry.annualPriceCents > 0 : entry.monthlyPriceCents > 0;
            return (
              <div
                key={entry.id}
                className={cn(
                  'flex flex-col rounded-[var(--radius-card)] border bg-surface p-5',
                  current ? 'border-brand ring-1 ring-brand/30' : 'border-border',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[15px] font-semibold text-ink">{entry.name}</h3>
                  {current && <Badge tone="brand">Current</Badge>}
                </div>
                {entry.tagline && (
                  <p className="mt-0.5 text-[13px] text-ink-muted">{entry.tagline}</p>
                )}
                <p className="mt-4">
                  {entry.isContactSales ? (
                    <span className="text-2xl font-semibold text-ink">Custom</span>
                  ) : free ? (
                    <span className="text-2xl font-semibold text-ink">Free</span>
                  ) : soldThisWay ? (
                    <>
                      <span className="text-2xl font-semibold text-ink">
                        {formatMoney(perMonth, entry.currency)}
                      </span>
                      <span className="text-[13px] text-ink-muted"> /month</span>
                      {interval === 'year' && (
                        <span className="block text-[12px] text-ink-subtle">
                          {formatMoney(price, entry.currency)} billed yearly
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-[13px] text-ink-muted">
                      Not available {interval === 'year' ? 'yearly' : 'monthly'}
                    </span>
                  )}
                </p>
                <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink">
                  <li>{limit(entry.maxProperties, 'website')}</li>
                  <li>{limit(entry.maxMembers, 'team member')}</li>
                  <li className={cn(!entry.aiAgent && 'text-ink-subtle line-through')}>AI agent</li>
                  <li className={cn(!entry.integrations && 'text-ink-subtle line-through')}>
                    API keys &amp; webhooks
                  </li>
                  <li className={cn(!entry.removeBranding && 'text-ink-subtle line-through')}>
                    Remove widget branding
                  </li>
                </ul>
                <div className="mt-5">
                  {entry.isContactSales ? (
                    <Button variant="secondary" fullWidth onClick={() => setEnquiryOpen(true)}>
                      Contact us
                    </Button>
                  ) : current && subscription.status !== 'canceled' ? (
                    <Button variant="secondary" fullWidth disabled>
                      Your plan
                    </Button>
                  ) : free ? (
                    <Button
                      variant="secondary"
                      fullWidth
                      disabled
                      title="Cancel your paid plan from the payment portal to return to Free"
                    >
                      Included
                    </Button>
                  ) : (
                    <Button
                      fullWidth
                      disabled={!canManage || !entry.purchasable || !soldThisWay}
                      loading={working === entry.key}
                      onClick={() => void choose(entry)}
                    >
                      {subscription.status === 'active' && subscription.provider === 'stripe'
                        ? 'Switch to this plan'
                        : `Choose ${entry.name}`}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <Card>
          <CardHeader
            title="Invoices"
            description="Every invoice Stripe has issued for this workspace. Receipts are emailed to the owner when paid."
          />
          {data.invoices.length === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-muted">No invoices yet.</p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-subtle">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Invoice</th>
                    <th className="px-5 py-2.5 font-medium">Period</th>
                    <th className="px-5 py-2.5 font-medium">Amount</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium text-right">Links</th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t border-border">
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink">{invoice.number ?? 'Pending'}</p>
                        <p className="text-[12px] text-ink-subtle">
                          {invoice.planName ?? '—'} · {formatDate(invoice.issuedAt)}
                        </p>
                      </td>
                      <td className="px-5 py-3 text-ink-muted">
                        {invoice.periodStart
                          ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
                          : '—'}
                      </td>
                      <td className="px-5 py-3 text-ink">
                        {formatMoney(
                          invoice.status === 'paid'
                            ? invoice.amountPaidCents
                            : invoice.amountDueCents,
                          invoice.currency,
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={INVOICE_TONE[invoice.status]}>{invoice.status}</Badge>
                      </td>
                      <td className="px-5 py-3 text-right">
                        {invoice.hostedInvoiceUrl && (
                          <a
                            href={invoice.hostedInvoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand hover:underline"
                          >
                            {invoice.status === 'open' ? 'Pay' : 'View'}
                          </a>
                        )}
                        {invoice.invoicePdfUrl && (
                          <a
                            href={invoice.invoicePdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-3 text-brand hover:underline"
                          >
                            PDF
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <EnquiryModal open={enquiryOpen} onClose={() => setEnquiryOpen(false)} />
    </>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number | null }) {
  const over = max !== null && used > max;
  const ratio = max === null ? 0 : Math.min(1, used / max);
  return (
    <div>
      <dt className="text-[13px] text-ink-muted">{label}</dt>
      <dd className="mt-1">
        <span className={cn('text-lg font-semibold', over ? 'text-danger' : 'text-ink')}>
          {used}
        </span>
        <span className="text-[13px] text-ink-muted"> of {max === null ? 'unlimited' : max}</span>
        {max !== null && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
            <div
              className={cn(
                'h-full rounded-full',
                over ? 'bg-danger' : ratio >= 1 ? 'bg-warning' : 'bg-brand',
              )}
              style={{ width: `${Math.max(4, ratio * 100)}%` }}
            />
          </div>
        )}
      </dd>
    </div>
  );
}

/**
 * One feature line: a green tick for what the plan includes, a cross and a crossed-out name for
 * what it does not. It used to be a tick or a dash under the heading
 * "Included", and a grey dash next to "AI agent" read as a bullet point - as if the free plan
 * had it.
 */
function Feature({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <p className={cn('flex items-center gap-1.5', !on && 'text-ink-subtle')}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('size-4 shrink-0', on ? 'text-success' : 'text-ink-subtle')}
        aria-hidden="true"
      >
        <path d={on ? 'M5 12.5 10 17l9-10' : 'M7 7l10 10M17 7 7 17'} />
      </svg>
      <span className={cn(!on && 'line-through')}>{children}</span>
      <span className="sr-only">{on ? ' included' : ' not included'}</span>
    </p>
  );
}

function EnquiryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [websites, setWebsites] = useState('');
  const [members, setMembers] = useState('');
  const [aiAgent, setAiAgent] = useState(true);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open && user) {
      setName((current) => current || user.name);
      setEmail((current) => current || user.email);
    }
  }, [open, user]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setErrors({});
    try {
      await api.post('/billing/enquiries', {
        name,
        email,
        message,
        wants: {
          ...(websites ? { websites: Number(websites) } : {}),
          ...(members ? { teamMembers: Number(members) } : {}),
          aiAgent,
        },
      });
      toast.success("Sent. We'll get back to you by email.");
      setMessage('');
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors());
        toast.error(error.message);
      } else {
        toast.error('Could not send that.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tell us what you need"
      description="Websites, people, the AI agent, anything else - and we'll come back with a price."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button type="submit" form="billing-enquiry" loading={sending}>
            Send
          </Button>
        </>
      }
    >
      <form id="billing-enquiry" onSubmit={(event) => void submit(event)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" required error={errors['name']}>
            {({ id, invalid }) => (
              <TextInput
                id={id}
                invalid={invalid}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Email" required error={errors['email']}>
            {({ id, invalid }) => (
              <TextInput
                id={id}
                type="email"
                invalid={invalid}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Websites" error={errors['wants.websites']}>
            {({ id }) => (
              <TextInput
                id={id}
                type="number"
                min={1}
                value={websites}
                onChange={(e) => setWebsites(e.target.value)}
                placeholder="e.g. 25"
              />
            )}
          </Field>
          <Field label="Team members" error={errors['wants.teamMembers']}>
            {({ id }) => (
              <TextInput
                id={id}
                type="number"
                min={1}
                value={members}
                onChange={(e) => setMembers(e.target.value)}
                placeholder="e.g. 40"
              />
            )}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={aiAgent}
            onChange={(e) => setAiAgent(e.target.checked)}
            className="size-4 accent-brand"
          />
          We want the AI agent
        </label>
        <Field
          label="Anything else"
          required
          error={errors['message']}
          hint="At least a sentence or two."
        >
          {({ id, invalid }) => (
            <textarea
              id={id}
              rows={4}
              required
              minLength={10}
              aria-invalid={invalid || undefined}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
