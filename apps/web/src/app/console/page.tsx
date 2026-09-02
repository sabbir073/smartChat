'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  planCode: string;
  planName: string;
  memberCount: number;
  propertyCount: number;
  conversationCount: number;
}

interface FlagRow {
  key: string;
  description: string;
  enabled: boolean;
  disabledAccountIds: string[];
}

interface HealthDto {
  database: { ok: boolean; ms: number; error?: string };
  activeAccounts: number;
  suspendedAccounts: number;
  pendingWebhookDeliveries: number;
  queuedEmails: number;
  failedWebhookDeliveries: number;
}

interface AuditRow {
  id: string;
  action: string;
  accountId: string | null;
  adminName: string;
  metadata: unknown;
  createdAt: string;
}

const TABS = ['accounts', 'billing', 'flags', 'health', 'audit'] as const;

/** A plan change waiting on somebody here. */
interface PlanChangeRow {
  id: string;
  accountId: string;
  accountName: string;
  fromPlan: string;
  toPlan: string;
  toPlanName: string;
  interval: string;
  createdAt: string;
  kind: 'scheduled_downgrade' | 'upgrade_request';
  effectiveAt: string | null;
}

interface InvoiceRow {
  id: string;
  accountId: string;
  accountName: string;
  number: number;
  planName: string;
  amountCents: number;
  currency: string;
  status: 'issued' | 'paid' | 'void';
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  reference: string | null;
}

function money(cents: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency.toUpperCase()] ?? '';
  const amount = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

/**
 * The platform console.
 *
 * One page, four views, and no cleverness: an operator opens this when something is wrong, and the
 * last thing they need is an interface with opinions. Every destructive action asks for a reason
 * in words, because the reason is what the affected account is shown.
 */
export default function ConsolePage() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>('accounts');
  const [admin, setAdmin] = useState<{ name: string; permissions: string[] } | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [suspending, setSuspending] = useState<AccountRow | null>(null);
  const [reason, setReason] = useState('');
  const [planChanges, setPlanChanges] = useState<PlanChangeRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [rejecting, setRejecting] = useState<PlanChangeRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [payRef, setPayRef] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const me = await api.get<{ name: string; permissions: string[] }>('/platform/auth/me');
      setAdmin(me.data);

      if (tab === 'accounts') {
        const result = await api.get<AccountRow[]>('/platform/accounts', {
          query: { ...(search.trim() ? { search: search.trim() } : {}), limit: 100 },
        });
        setAccounts(result.data);
      } else if (tab === 'billing') {
        const [changes, bills] = await Promise.all([
          api.get<PlanChangeRow[]>('/platform/plan-changes', { query: { status: 'pending' } }),
          api.get<InvoiceRow[]>('/platform/invoices'),
        ]);
        setPlanChanges(changes.data);
        setInvoices(bills.data);
      } else if (tab === 'flags') {
        setFlags((await api.get<FlagRow[]>('/platform/flags')).data);
      } else if (tab === 'health') {
        setHealth((await api.get<HealthDto>('/platform/health')).data);
      } else {
        setAudit((await api.get<AuditRow[]>('/platform/audit', { query: { limit: 50 } })).data);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.replace('/console/login');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'That could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [tab, search, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function suspend(): Promise<void> {
    if (!suspending) return;
    try {
      await api.post(`/platform/accounts/${suspending.id}/suspend`, { reason });
      setSuspending(null);
      setReason('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be done.');
    }
  }

  async function resume(account: AccountRow): Promise<void> {
    try {
      await api.post(`/platform/accounts/${account.id}/resume`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be done.');
    }
  }

  /**
   * Approve a plan change.
   *
   * Approving is one click because the customer already asked for it and the operator is agreeing.
   * Refusing opens a dialog, because a refusal without a reason is the thing the customer will
   * write in about - and the note goes to them.
   */
  async function decide(
    change: PlanChangeRow,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<void> {
    try {
      await api.post(`/platform/plan-changes/${change.id}/decide`, {
        decision,
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      setRejecting(null);
      setRejectNote('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be recorded.');
    }
  }

  async function recordPayment(): Promise<void> {
    if (!paying) return;
    try {
      await api.post(`/platform/invoices/${paying.id}/paid`, {
        ...(payRef.trim() ? { reference: payRef.trim() } : {}),
      });
      setPaying(null);
      setPayRef('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be recorded.');
    }
  }

  async function toggleFlag(flag: FlagRow): Promise<void> {
    try {
      await api.patch(`/platform/flags/${flag.key}`, { enabled: !flag.enabled });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be changed.');
    }
  }

  async function signOut(): Promise<void> {
    await api.post('/platform/auth/logout').catch(() => undefined);
    router.replace('/console/login');
  }

  const upgrades = planChanges.filter((change) => change.kind !== 'scheduled_downgrade');
  const scheduled = planChanges.filter((change) => change.kind === 'scheduled_downgrade');

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium uppercase tracking-wide text-ink-inverted/50">
            SmartChat
          </p>
          <h1 className="mt-1 text-[26px] font-semibold">Platform console</h1>
        </div>
        <div className="text-right text-[13px] text-ink-inverted/60">
          {admin?.name}
          <button
            type="button"
            onClick={() => void signOut()}
            className="ml-3 text-brand-ring hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-[var(--radius-control)] bg-danger/20 px-3 py-2 text-[13px] text-danger-soft">
          {error}
        </p>
      )}

      <nav className="mb-6 flex gap-1">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize ${
              tab === entry
                ? 'bg-ink-inverted text-ink'
                : 'text-ink-inverted/60 hover:bg-ink-inverted/10'
            }`}
          >
            {entry}
          </button>
        ))}
      </nav>

      {busy && <p className="text-sm text-ink-inverted/50">Loading…</p>}

      {!busy && tab === 'accounts' && (
        <>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or slug"
            className="mb-4 h-10 w-full max-w-sm rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 text-sm text-ink-inverted"
          />
          <div className="space-y-2">
            {accounts.length === 0 && (
              <p className="text-sm text-ink-inverted/50">No accounts matched.</p>
            )}
            {accounts.map((account) => (
              <div
                key={account.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                    {account.name}
                    {account.status !== 'active' && (
                      <span className="rounded-full bg-danger/30 px-2 py-0.5 text-[11px] font-medium text-danger-soft">
                        {account.status}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-inverted/50">
                    {account.slug} · {account.planName} · {account.memberCount} people ·{' '}
                    {account.propertyCount} websites · {account.conversationCount} conversations
                  </p>
                  {account.suspendedReason && (
                    <p className="mt-1 text-[13px] text-danger-soft">
                      Suspended: {account.suspendedReason}
                    </p>
                  )}
                </div>
                {account.status === 'suspended' ? (
                  <button
                    type="button"
                    onClick={() => void resume(account)}
                    className="rounded-[var(--radius-control)] bg-ink-inverted px-3 py-1.5 text-[13px] font-medium text-ink"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setSuspending(account);
                      setReason('');
                    }}
                    className="rounded-[var(--radius-control)] border border-danger/40 px-3 py-1.5 text-[13px] font-medium text-danger-soft"
                  >
                    Suspend
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {!busy && tab === 'billing' && (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-inverted/50">
              Plan changes waiting on us ({upgrades.length})
            </h2>
            {upgrades.length === 0 ? (
              <p className="text-[13px] text-ink-inverted/50">
                Nothing waiting. Moves to a free plan apply themselves, and a downgrade to a
                cheaper paid plan is already agreed — both are listed below rather than here.
              </p>
            ) : (
              <div className="space-y-2">
                {upgrades.map((change) => (
                  <div
                    key={change.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold">{change.accountName}</p>
                      <p className="mt-0.5 text-[13px] text-ink-inverted/50">
                        {change.fromPlan} → {change.toPlanName} ({change.interval}) · asked{' '}
                        {new Date(change.createdAt).toLocaleDateString('en-GB')}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRejecting(change);
                          setRejectNote('');
                        }}
                        className="rounded-[var(--radius-control)] border border-danger/40 px-3 py-1.5 text-[13px] font-medium text-danger-soft"
                      >
                        Refuse
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(change, 'approved')}
                        className="rounded-[var(--radius-control)] bg-ink-inverted px-3 py-1.5 text-[13px] font-medium text-ink"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {scheduled.length > 0 && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-inverted/50">
                Downgrades already agreed ({scheduled.length})
              </h2>
              {/*
                Deliberately without buttons. These are not decisions - the customer asked for a
                cheaper plan and it lands when the period they have already paid for runs out.
                An Approve button here would only be a way to take that period away early.
              */}
              <div className="space-y-2">
                {scheduled.map((change) => (
                  <div
                    key={change.id}
                    className="rounded-[var(--radius-card)] border border-ink-inverted/15 px-4 py-3"
                  >
                    <p className="text-[15px] font-semibold">{change.accountName}</p>
                    <p className="mt-0.5 text-[13px] text-ink-inverted/50">
                      {change.fromPlan} → {change.toPlanName} ({change.interval}) ·{' '}
                      {change.effectiveAt
                        ? `takes effect ${new Date(change.effectiveAt).toLocaleDateString('en-GB')}`
                        : 'takes effect at the end of the period'}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-inverted/50">
              Invoices
            </h2>
            {invoices.length === 0 ? (
              <p className="text-[13px] text-ink-inverted/50">
                No invoices yet. Free plans do not raise one.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-ink-inverted/15">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead>
                    <tr className="border-b border-ink-inverted/15 text-left text-ink-inverted/50">
                      <th className="px-4 py-2.5 font-medium">#</th>
                      <th className="px-4 py-2.5 font-medium">Account</th>
                      <th className="px-4 py-2.5 font-medium">Plan</th>
                      <th className="px-4 py-2.5 font-medium">Amount</th>
                      <th className="px-4 py-2.5 font-medium">Period</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr
                        key={invoice.id}
                        className="border-b border-ink-inverted/10 last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">{invoice.number}</td>
                        <td className="px-4 py-2.5">{invoice.accountName}</td>
                        <td className="px-4 py-2.5 text-ink-inverted/60">{invoice.planName}</td>
                        <td className="px-4 py-2.5">
                          {money(invoice.amountCents, invoice.currency)}
                        </td>
                        <td className="px-4 py-2.5 text-ink-inverted/60">
                          {new Date(invoice.periodStart).toLocaleDateString('en-GB')} –{' '}
                          {new Date(invoice.periodEnd).toLocaleDateString('en-GB')}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              invoice.status === 'paid'
                                ? 'text-success-soft'
                                : invoice.status === 'void'
                                  ? 'text-ink-inverted/40'
                                  : 'text-warning-soft'
                            }
                          >
                            {invoice.status}
                          </span>
                          {invoice.reference && (
                            <span className="ml-2 text-ink-inverted/40">{invoice.reference}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {invoice.status === 'issued' && (
                            <button
                              type="button"
                              onClick={() => {
                                setPaying(invoice);
                                setPayRef('');
                              }}
                              className="rounded-[var(--radius-control)] border border-ink-inverted/25 px-3 py-1.5 text-[13px] font-medium text-ink-inverted"
                            >
                              Record payment
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {!busy && tab === 'flags' && (
        <div className="space-y-2">
          {flags.map((flag) => (
            <div
              key={flag.key}
              className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-[14px] font-semibold">{flag.key}</p>
                <p className="mt-0.5 text-[13px] text-ink-inverted/50">{flag.description}</p>
                {flag.disabledAccountIds.length > 0 && (
                  <p className="mt-1 text-[13px] text-warning">
                    Off for {flag.disabledAccountIds.length} account
                    {flag.disabledAccountIds.length === 1 ? '' : 's'}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void toggleFlag(flag)}
                className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-medium ${
                  flag.enabled
                    ? 'bg-success/25 text-success'
                    : 'border border-danger/40 text-danger-soft'
                }`}
              >
                {flag.enabled ? 'On' : 'Off'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!busy && tab === 'health' && health && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label="Database"
            value={health.database.ok ? `${health.database.ms} ms` : 'unreachable'}
            bad={!health.database.ok}
          />
          <Stat label="Active accounts" value={String(health.activeAccounts)} />
          <Stat label="Suspended accounts" value={String(health.suspendedAccounts)} />
          <Stat label="Emails queued" value={String(health.queuedEmails)} />
          <Stat
            label="Webhook deliveries pending"
            value={String(health.pendingWebhookDeliveries)}
          />
          <Stat
            label="Webhook deliveries given up on"
            value={String(health.failedWebhookDeliveries)}
            bad={health.failedWebhookDeliveries > 0}
          />
          <p className="text-[13px] text-ink-inverted/40 sm:col-span-2">
            Counts, not verdicts. How many pending deliveries is too many depends on the hour, and a
            threshold guessed here would either cry wolf or stay quiet during the outage.
          </p>
        </div>
      )}

      {!busy && tab === 'audit' && (
        <div className="space-y-1.5">
          {audit.length === 0 && <p className="text-sm text-ink-inverted/50">Nothing yet.</p>}
          {audit.map((entry) => (
            <div key={entry.id} className="flex flex-wrap gap-2 text-[13px]">
              <span className="font-mono text-brand-ring">{entry.action}</span>
              <span className="text-ink-inverted/70">{entry.adminName}</span>
              <span className="text-ink-inverted/40">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
              {entry.accountId && (
                <span className="font-mono text-ink-inverted/40">
                  {entry.accountId.slice(0, 8)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {suspending && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-[var(--radius-card)] border border-ink-inverted/20 bg-ink p-5">
            <h2 className="text-[17px] font-semibold">Suspend {suspending.name}?</h2>
            <p className="mt-1.5 text-[13px] text-ink-inverted/60">
              Everybody in this account is locked out on their very next request, and its widgets
              stop serving. The reason is shown to them, so write something they can act on.
            </p>
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Non-payment since March; contact billing@"
              className="mt-3 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 py-2 text-sm text-ink-inverted"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSuspending(null)}
                className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] text-ink-inverted/70"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={reason.trim().length < 4}
                onClick={() => void suspend()}
                className="rounded-[var(--radius-control)] bg-danger px-3 py-1.5 text-[13px] font-medium text-ink-inverted disabled:opacity-50"
              >
                Suspend
              </button>
            </div>
          </div>
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-[var(--radius-card)] border border-ink-inverted/20 bg-ink p-5">
            <h2 className="text-[17px] font-semibold">
              Refuse the move to {rejecting.toPlanName}?
            </h2>
            <p className="mt-1.5 text-[13px] text-ink-inverted/60">
              Nothing on {rejecting.accountName} changes - they stay on {rejecting.fromPlan} and keep
              everything they have. The note below is what they are told, so write the thing they
              need to do next.
            </p>
            <textarea
              rows={3}
              value={rejectNote}
              onChange={(event) => setRejectNote(event.target.value)}
              placeholder="We could not take payment for the first period - reply to this email once it is settled and we will approve it."
              className="mt-3 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 py-2 text-sm text-ink-inverted"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRejecting(null);
                  setRejectNote('');
                }}
                className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] text-ink-inverted/70"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={rejectNote.trim().length < 4}
                onClick={() => void decide(rejecting, 'rejected', rejectNote)}
                className="rounded-[var(--radius-control)] bg-danger px-3 py-1.5 text-[13px] font-medium text-ink-inverted disabled:opacity-50"
              >
                Refuse
              </button>
            </div>
          </div>
        </div>
      )}

      {paying && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-[var(--radius-card)] border border-ink-inverted/20 bg-ink p-5">
            <h2 className="text-[17px] font-semibold">
              Record payment of {money(paying.amountCents, paying.currency)}?
            </h2>
            <p className="mt-1.5 text-[13px] text-ink-inverted/60">
              Invoice #{paying.number} for {paying.accountName}. This marks it paid and, if the
              account was past due or read-only, puts it back to normal straight away. It does not
              move money - record it here only once the money has actually arrived.
            </p>
            <label
              htmlFor="payment-reference"
              className="mt-3 block text-[13px] text-ink-inverted/70"
            >
              Reference (optional)
            </label>
            <input
              id="payment-reference"
              type="text"
              value={payRef}
              onChange={(event) => setPayRef(event.target.value)}
              placeholder="Bank transfer 2026-08-31, ref SC-1042"
              maxLength={200}
              className="mt-1.5 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 py-2 text-sm text-ink-inverted"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPaying(null);
                  setPayRef('');
                }}
                className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] text-ink-inverted/70"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void recordPayment()}
                className="rounded-[var(--radius-control)] bg-ink-inverted px-3 py-1.5 text-[13px] font-medium text-ink"
              >
                Record payment
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 px-4 py-3">
      <p className="text-[13px] text-ink-inverted/50">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold ${bad ? 'text-danger-soft' : ''}`}>{value}</p>
    </div>
  );
}
