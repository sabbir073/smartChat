'use client';

import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/components/ui';
import type { PublicPlan } from '@/lib/public-api';

/**
 * The pricing table.
 *
 * Every number on this page comes from the `plans` table over `/public/plans` - the prices, the
 * limits and the feature flags alike. Nothing here is written twice, which is the only way the
 * page and the enforcement can be guaranteed to agree: if the Free plan stops including the
 * knowledge base, this page says so on the next request without anybody editing it.
 */

const LIMIT_ROWS: { key: string; label: string; format?: (value: number) => string }[] = [
  { key: 'max_properties', label: 'Websites' },
  { key: 'max_agents', label: 'Team members' },
  { key: 'max_monthly_conversations', label: 'Conversations / month' },
  { key: 'max_storage_bytes', label: 'File storage', format: formatBytes },
  { key: 'max_kb_articles', label: 'Help centre articles' },
  { key: 'max_triggers', label: 'Automation rules' },
  { key: 'max_shortcuts', label: 'Saved replies' },
  { key: 'max_webhooks', label: 'Webhooks' },
  { key: 'max_api_requests_per_day', label: 'API requests / day' },
  { key: 'max_conversation_history_days', label: 'History kept', format: (value) => `${value} days` },
];

const FEATURE_ROWS: { key: string; label: string }[] = [
  { key: 'feature_knowledge_base', label: 'Help centre' },
  { key: 'feature_tickets', label: 'Tickets & email' },
  { key: 'feature_triggers', label: 'Automation rules' },
  { key: 'feature_file_attachments', label: 'File attachments' },
  { key: 'feature_webhooks', label: 'Webhooks' },
  { key: 'feature_public_api', label: 'Public API' },
  { key: 'feature_custom_roles', label: 'Custom roles' },
  { key: 'feature_remove_branding', label: 'Remove SmartChat branding' },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${Math.round(bytes / 1_073_741_824)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  return `${bytes} bytes`;
}

function money(cents: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency.toUpperCase()] ?? '';
  const amount = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

/** `null` is unlimited, everywhere. Said as a word rather than as an em dash nobody can read. */
function limitText(value: number | null | undefined, format?: (value: number) => string): string {
  if (value === null || value === undefined) return 'Unlimited';
  return format ? format(value) : value.toLocaleString('en-GB');
}

export function PricingTable({ plans }: { plans: PublicPlan[] }) {
  const [yearly, setYearly] = useState(false);
  const selectable = plans.filter((plan) => !plan.isContactSales);
  const saving = Math.max(0, ...selectable.map((plan) => plan.annualSavingMonths));

  return (
    <>
      <div className="mt-8 flex flex-col items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Billing period"
          className="inline-flex rounded-full border border-border bg-surface p-1"
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
        {saving > 0 && (
          <p className="text-[13px] text-ink-muted">
            Yearly billing saves {saving === Math.round(saving) ? saving : saving.toFixed(1)} months.
          </p>
        )}
      </div>

      {/* Cards */}
      <div className="mt-10 grid gap-4 lg:grid-cols-4">
        {plans.map((plan) => {
          const price = yearly ? plan.priceYearlyCents : plan.priceMonthlyCents;
          const highlighted = plan.code === 'starter';

          return (
            <div
              key={plan.code}
              className={cn(
                'flex flex-col rounded-[var(--radius-card)] border bg-surface p-6',
                highlighted ? 'border-brand shadow-sm ring-1 ring-brand/20' : 'border-border',
              )}
            >
              {highlighted && (
                <p className="mb-3 inline-flex w-fit rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
                  Most chosen
                </p>
              )}
              <h3 className="text-[17px] font-semibold text-ink">{plan.name}</h3>
              {plan.tagline && (
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{plan.tagline}</p>
              )}

              <p className="mt-5">
                {plan.isContactSales ? (
                  <span className="text-[26px] font-semibold tracking-tight text-ink">
                    Talk to us
                  </span>
                ) : (
                  <>
                    <span className="text-[32px] font-semibold tracking-tight text-ink">
                      {money(price, plan.currency)}
                    </span>
                    <span className="ml-1 text-[13px] text-ink-muted">
                      {price === 0 ? 'forever' : yearly ? '/ year' : '/ month'}
                    </span>
                  </>
                )}
              </p>

              <Link
                href={plan.isContactSales ? '/contact' : '/register'}
                className={cn(
                  'mt-6 rounded-[var(--radius-control)] px-4 py-2.5 text-center text-sm font-medium transition-colors',
                  highlighted
                    ? 'bg-brand text-ink-inverted hover:bg-brand-hover'
                    : 'border border-border-strong text-ink hover:bg-surface-raised',
                )}
              >
                {plan.isContactSales
                  ? 'Contact us'
                  : plan.priceMonthlyCents === 0
                    ? 'Start free'
                    : `Choose ${plan.name}`}
              </Link>

              <ul className="mt-6 space-y-2 border-t border-border pt-5">
                {LIMIT_ROWS.slice(0, 4).map((row) => (
                  <li key={row.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-ink-muted">{row.label}</span>
                    <span className="text-right font-medium text-ink">
                      {limitText(plan.limits[row.key], row.format)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* The full table. Same data, every row. */}
      <div className="mt-16 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <caption className="sr-only">Full plan comparison</caption>
          <thead>
            <tr>
              <th scope="col" className="w-56 py-3 text-left font-semibold text-ink">
                Compare everything
              </th>
              {plans.map((plan) => (
                <th key={plan.code} scope="col" className="py-3 text-left font-semibold text-ink">
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th
                colSpan={plans.length + 1}
                scope="colgroup"
                className="border-t border-border pb-2 pt-6 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-subtle"
              >
                Limits
              </th>
            </tr>
            {LIMIT_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <th scope="row" className="py-2.5 text-left font-normal text-ink-muted">
                  {row.label}
                </th>
                {plans.map((plan) => (
                  <td key={plan.code} className="py-2.5 text-ink">
                    {limitText(plan.limits[row.key], row.format)}
                  </td>
                ))}
              </tr>
            ))}

            <tr>
              <th
                colSpan={plans.length + 1}
                scope="colgroup"
                className="border-t border-border pb-2 pt-6 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-subtle"
              >
                Included
              </th>
            </tr>
            {FEATURE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <th scope="row" className="py-2.5 text-left font-normal text-ink-muted">
                  {row.label}
                </th>
                {plans.map((plan) => {
                  // Absent means included: features are opt-out per plan, which is the same rule
                  // the server enforces. Reading it differently here is how a pricing page starts
                  // lying.
                  const on = plan.features[row.key] ?? true;
                  return (
                    <td key={plan.code} className="py-2.5">
                      <span className={on ? 'text-success' : 'text-ink-subtle'}>
                        {on ? 'Yes' : 'No'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
