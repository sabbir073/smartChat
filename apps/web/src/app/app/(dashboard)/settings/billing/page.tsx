'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Modal,
  Spinner,
  cn,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useResource } from '@/lib/use-resource';

/**
 * Billing, from the customer's side.
 *
 * The page answers four questions in the order somebody actually asks them: what am I on, what am
 * I using against it, what would change if I moved, and what have I been invoiced. Anything that
 * cannot be done here says why rather than being hidden - a disabled button with no explanation is
 * how a support ticket gets opened.
 */

interface UsageLine {
  key: string;
  used: number;
  limit: number | null;
  over: boolean;
}

interface Overview {
  plan: { id: string; code: string; name: string; tagline: string | null };
  status: 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';
  interval: 'monthly' | 'yearly';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  amountCents: number;
  currency: string;
  usage: UsageLine[];
  features: Record<string, boolean>;
  pendingChange: {
    id: string;
    status: string;
    interval: string;
    createdAt: string;
    toPlanName: string;
    fromPlanName: string;
    kind: 'scheduled_downgrade' | 'upgrade_request';
    effectiveAt: string | null;
  } | null;
  isPaused: boolean;
  canSelfServe: boolean;
}

interface PublicPlan {
  code: string;
  name: string;
  tagline: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  isContactSales: boolean;
  annualSavingMonths: number;
  limits: Record<string, number | null>;
}

interface InvoiceDto {
  id: string;
  number: number;
  planName: string;
  interval: string;
  amountCents: number;
  currency: string;
  status: 'issued' | 'paid' | 'void';
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  reference: string | null;
}

const LABELS: Record<string, string> = {
  max_properties: 'Websites',
  max_agents: 'Team members',
  max_monthly_conversations: 'Conversations this month',
  max_storage_bytes: 'File storage',
  max_kb_articles: 'Help centre articles',
  max_webhooks: 'Webhooks',
  max_triggers: 'Automation rules',
  max_shortcuts: 'Saved replies',
};

function money(cents: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency.toUpperCase()] ?? '';
  const amount = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

function bytes(value: number): string {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
  if (value >= 1_048_576) return `${Math.round(value / 1_048_576)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function amount(key: string, value: number): string {
  return key === 'max_storage_bytes' ? bytes(value) : value.toLocaleString('en-GB');
}

const date = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The banner at the top. Its wording is the most important copy on the page. */
function StatusBanner({ overview }: { overview: Overview }) {
  if (overview.isPaused) {
    return (
      <Alert tone="danger" title="This account is read-only">
        Nothing has been deleted. Every conversation, ticket, article and file is still here and
        still readable — your widget has stopped taking new conversations and your team can read but
        not write. Settling the outstanding invoice restores everything immediately.
      </Alert>
    );
  }

  if (overview.status === 'past_due' && overview.graceEndsAt) {
    return (
      <Alert tone="warning" title="There is an unpaid invoice">
        Your service continues as normal until {date(overview.graceEndsAt)}. After that the account
        becomes read-only — nothing is deleted, and paying restores it at once.
      </Alert>
    );
  }

  if (overview.cancelAtPeriodEnd) {
    return (
      <Alert tone="warning" title="This subscription is set to end">
        You keep everything until {date(overview.currentPeriodEnd)}. After that the account becomes
        read-only rather than being deleted, so you can come back or export at any point.
      </Alert>
    );
  }

  if (overview.status === 'trialing' && overview.trialEndsAt) {
    return (
      <Alert tone="info" title={`Trial ends ${date(overview.trialEndsAt)}`}>
        You have everything on {overview.plan.name} until then. Choose a plan whenever you are
        ready — nothing is lost either way.
      </Alert>
    );
  }

  return null;
}

export default function BillingPage() {
  const { can } = useAuth();
  const toast = useToast();
  const mayManage = can('account:billing');

  const overview = useResource<Overview>(
    (signal) => api.get<Overview>('/billing/subscription', { signal }).then((r) => r.data),
    [],
  );
  const plans = useResource<PublicPlan[]>(
    (signal) => api.get<PublicPlan[]>('/public/plans', { signal }).then((r) => r.data),
    [],
  );
  const invoices = useResource<InvoiceDto[]>(
    (signal) => api.get<InvoiceDto[]>('/billing/invoices', { signal }).then((r) => r.data),
    [],
  );

  const [yearly, setYearly] = useState(false);
  const [confirming, setConfirming] = useState<PublicPlan | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);

  const data = overview.data;

  async function choose(plan: PublicPlan) {
    setBusy(true);
    try {
      const { data: result } = await api.post<{ status: 'applied' | 'pending' }>('/billing/plan', {
        planCode: plan.code,
        interval: yearly ? 'yearly' : 'monthly',
      });
      toast.success(
        result.status === 'applied'
          ? `You are now on ${plan.name}.`
          : `We have your request to move to ${plan.name}. We will confirm by email.`,
      );
      setConfirming(null);
      overview.reload();
      invoices.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be requested.');
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, body: unknown, message: string) {
    setBusy(true);
    try {
      await api.post(path, body);
      toast.success(message);
      setCancelling(false);
      overview.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await api.delete(`/billing/plan/${id}`);
      toast.success('Request withdrawn.');
      overview.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (overview.loading || !data) {
    return (
      <div className="p-6">
        <PageHeader title="Billing" description="Your plan, what you are using, and your invoices." />
        <div className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner className="size-4" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Billing" description="Your plan, what you are using, and your invoices." />

      <StatusBanner overview={data} />

      {!mayManage && (
        <Alert tone="info" title="You can see this, but not change it">
          Changing the plan needs the billing permission. Ask an owner or admin on your team.
        </Alert>
      )}

      {/* Current plan */}
      <Card>
        <CardHeader title="Current plan" />
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[18px] font-semibold text-ink">{data.plan.name}</h3>
                <Badge
                  tone={
                    data.isPaused
                      ? 'danger'
                      : data.status === 'past_due'
                        ? 'warning'
                        : data.status === 'trialing'
                          ? 'brand'
                          : 'success'
                  }
                >
                  {data.status === 'past_due' ? 'unpaid' : data.status}
                </Badge>
              </div>
              {data.plan.tagline && (
                <p className="mt-1 text-[13px] text-ink-muted">{data.plan.tagline}</p>
              )}
              <p className="mt-3 text-[13px] text-ink-muted">
                {data.amountCents === 0
                  ? 'Free — no invoice is raised for this plan.'
                  : `${money(data.amountCents, data.currency)} ${data.interval === 'yearly' ? 'a year' : 'a month'}`}
                {' · '}
                Current period {date(data.currentPeriodStart)} – {date(data.currentPeriodEnd)}
              </p>
            </div>

            {mayManage && (
              <div className="flex flex-wrap gap-2">
                {data.cancelAtPeriodEnd ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => act('/billing/resume', {}, 'Your subscription will continue.')}
                  >
                    Keep my subscription
                  </Button>
                ) : (
                  data.amountCents > 0 && (
                    <Button variant="secondary" disabled={busy} onClick={() => setCancelling(true)}>
                      Cancel
                    </Button>
                  )
                )}
              </div>
            )}
          </div>

          {data.pendingChange && (
            <div className="mt-5 rounded-[var(--radius-control)] border border-border bg-surface-raised px-4 py-3">
              <p className="text-[13px] text-ink">
                {data.pendingChange.kind === 'scheduled_downgrade' ? (
                  <>
                    Scheduled: <strong>{data.pendingChange.fromPlanName}</strong> →{' '}
                    <strong>{data.pendingChange.toPlanName}</strong> (
                    {data.pendingChange.interval})
                    {data.pendingChange.effectiveAt
                      ? `, on ${date(data.pendingChange.effectiveAt)}`
                      : ''}
                    . You keep everything you have paid for until then, and nothing is removed
                    after it.
                  </>
                ) : (
                  <>
                    Waiting on us: <strong>{data.pendingChange.fromPlanName}</strong> →{' '}
                    <strong>{data.pendingChange.toPlanName}</strong> (
                    {data.pendingChange.interval}), requested{' '}
                    {date(data.pendingChange.createdAt)}.
                  </>
                )}
              </p>
              {mayManage && (
                <Button
                  variant="ghost"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => withdraw(data.pendingChange?.id ?? '')}
                >
                  Withdraw the request
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader
          title="What you are using"
          description="Counted live. A bar past its limit means a downgrade left you over it — nothing was removed."
        />
        <CardBody>
          <ul className="space-y-4">
            {data.usage.map((line) => {
              const pct =
                line.limit === null || line.limit === 0
                  ? 0
                  : Math.min(100, Math.round((line.used / line.limit) * 100));
              return (
                <li key={line.key}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-ink">{LABELS[line.key] ?? line.key}</span>
                    <span className={cn('font-medium', line.over ? 'text-danger' : 'text-ink-muted')}>
                      {amount(line.key, line.used)}
                      {line.limit === null ? ' of unlimited' : ` of ${amount(line.key, line.limit)}`}
                    </span>
                  </div>
                  {line.limit !== null && (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width]',
                          line.over ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-brand',
                        )}
                        style={{ width: `${line.over ? 100 : pct}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      {/* Plans */}
      {mayManage && data.canSelfServe && (
        <Card>
          <CardHeader
            title="Change plan"
            description="Moving up takes effect once we confirm it. Moving down takes effect at the end of the period you have already paid for."
          />
          <CardBody>
            <div
              role="radiogroup"
              aria-label="Billing period"
              className="mb-5 inline-flex rounded-full border border-border bg-canvas p-1"
            >
              {[
                { value: false, label: 'Monthly' },
                { value: true, label: 'Yearly' },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={yearly === option.value}
                  onClick={() => setYearly(option.value)}
                  className={cn(
                    'rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors',
                    yearly === option.value
                      ? 'bg-brand text-ink-inverted'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(plans.data ?? []).map((plan) => {
                const current = plan.code === data.plan.code;
                const price = yearly ? plan.priceYearlyCents : plan.priceMonthlyCents;
                return (
                  <div
                    key={plan.code}
                    className={cn(
                      'flex flex-col rounded-[var(--radius-card)] border p-4',
                      current ? 'border-brand bg-brand-soft/40' : 'border-border bg-surface',
                    )}
                  >
                    <h4 className="text-[14px] font-semibold text-ink">{plan.name}</h4>
                    <p className="mt-1 text-[13px] text-ink-muted">
                      {plan.isContactSales ? 'Talk to us' : money(price, plan.currency)}
                      {!plan.isContactSales && price > 0 && (yearly ? ' / year' : ' / month')}
                    </p>
                    <div className="flex-1" />
                    {current ? (
                      <p className="mt-3 text-[12px] font-medium text-brand">Your current plan</p>
                    ) : plan.isContactSales ? (
                      <p className="mt-3 text-[12px] text-ink-subtle">
                        Arranged with our team — see the contact page.
                      </p>
                    ) : (
                      <Button
                        variant="secondary"
                        className="mt-3"
                        disabled={busy}
                        onClick={() => setConfirming(plan)}
                      >
                        Choose {plan.name}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Invoices */}
      <Card>
        <CardHeader title="Invoices" description="Every period that has been billed." />
        <CardBody>
          {(invoices.data ?? []).length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              {/*
                Which of the two reasons applies depends on the plan, and saying the wrong one is
                worse than saying nothing: a Starter customer told "a free plan does not raise one"
                reasonably concludes they are not being billed.
              */}
              {data.amountCents === 0
                ? 'No invoices yet — a free plan does not raise one.'
                : `No invoices yet. The first covers the period ending ${date(data.currentPeriodEnd)}.`}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-ink-subtle">
                    <th className="py-2 font-medium">Number</th>
                    <th className="py-2 font-medium">Period</th>
                    <th className="py-2 font-medium">Plan</th>
                    <th className="py-2 font-medium">Amount</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(invoices.data ?? []).map((invoice) => (
                    <tr key={invoice.id} className="border-b border-border last:border-0">
                      <td className="py-2.5 font-medium text-ink">#{invoice.number}</td>
                      <td className="py-2.5 text-ink-muted">
                        {date(invoice.periodStart)} – {date(invoice.periodEnd)}
                      </td>
                      <td className="py-2.5 text-ink-muted">{invoice.planName}</td>
                      <td className="py-2.5 text-ink">
                        {money(invoice.amountCents, invoice.currency)}
                      </td>
                      <td className="py-2.5">
                        <Badge
                          tone={
                            invoice.status === 'paid'
                              ? 'success'
                              : invoice.status === 'void'
                                ? 'neutral'
                                : 'warning'
                          }
                        >
                          {invoice.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Confirm a plan change */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Move to ${confirming.name}?` : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => confirming && choose(confirming)} disabled={busy}>
              {busy ? 'Requesting…' : 'Confirm'}
            </Button>
          </>
        }
      >
        {confirming && (
          <div className="space-y-3 text-[14px] leading-relaxed text-ink-muted">
            <p>
              {confirming.name} is{' '}
              <strong className="text-ink">
                {money(
                  yearly ? confirming.priceYearlyCents : confirming.priceMonthlyCents,
                  confirming.currency,
                )}
              </strong>{' '}
              {yearly ? 'a year' : 'a month'}.
            </p>
            <p>
              {(yearly ? confirming.priceYearlyCents : confirming.priceMonthlyCents) <
              data.amountCents
                ? 'This is a downgrade, so it takes effect at the end of the period you have already paid for. You keep everything until then.'
                : 'We will set this up and confirm by email. Nothing changes on your account until we do, and you can withdraw the request before then.'}
            </p>
          </div>
        )}
      </Modal>

      {/* Confirm a cancellation */}
      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this subscription?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(false)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                act('/billing/cancel', { immediately: false }, 'Your subscription will end at the period.')
              }
            >
              {busy ? 'Cancelling…' : 'Cancel at period end'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[14px] leading-relaxed text-ink-muted">
          <p>
            You keep everything until <strong className="text-ink">{date(data.currentPeriodEnd)}</strong>.
          </p>
          <p>
            After that the account becomes read-only. Nothing is deleted — every conversation,
            ticket, article and file stays readable, and choosing a plan again restores full service.
          </p>
        </div>
      </Modal>
    </div>
  );
}
