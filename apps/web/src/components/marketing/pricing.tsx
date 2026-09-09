'use client';

import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/components/ui';
import { formatMoney } from '@/lib/billing';

/**
 * The plans, as the public site shows them.
 *
 * Fed by the API rather than written here: the operator edits prices and limits in the console,
 * and a pricing page that disagreed with the checkout would be the worst kind of wrong. The
 * shape is the public `/billing/plans` response.
 */

export interface PublicPlan {
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
  aiOwnKey: boolean;
  isContactSales: boolean;
  sortOrder: number;
}

type Interval = 'month' | 'year';

function limit(value: number | null, singular: string, plural: string): string {
  if (value === null) return `Unlimited ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

export function PricingTable({
  plans,
  compact = false,
}: {
  plans: PublicPlan[];
  /** The home page's version: no toggle, monthly prices, fewer words. */
  compact?: boolean;
}) {
  const [interval, setInterval] = useState<Interval>('month');
  const hasYearly = plans.some((plan) => plan.annualPriceCents > 0);
  const yearlySaving = (() => {
    const priced = plans.find((p) => p.monthlyPriceCents > 0 && p.annualPriceCents > 0);
    if (!priced) return null;
    const saving = 1 - priced.annualPriceCents / (priced.monthlyPriceCents * 12);
    return saving > 0 ? Math.round(saving * 100) : null;
  })();
  // The plan with the most going for it gets the highlight: the priced one with the most
  // features, which for the seeded set is Growth.
  const highlighted =
    plans
      .filter((p) => !p.isContactSales && p.monthlyPriceCents > 0)
      .sort(
        (a, b) =>
          Number(b.aiAgent) +
          Number(b.integrations) +
          Number(b.removeBranding) -
          (Number(a.aiAgent) + Number(a.integrations) + Number(a.removeBranding)),
      )[0]?.id ?? null;

  return (
    <div>
      {hasYearly && !compact && (
        <div className="mb-8 flex justify-center">
          <div
            role="group"
            aria-label="Billing period"
            className="inline-flex items-center rounded-full border border-border bg-surface p-1 text-[14px] font-medium"
          >
            {(['month', 'year'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setInterval(entry)}
                aria-pressed={interval === entry}
                className={cn(
                  'rounded-full px-4 py-1.5 transition-colors',
                  interval === entry ? 'bg-ink text-ink-inverted' : 'text-ink-muted hover:text-ink',
                )}
              >
                {entry === 'month' ? 'Monthly' : 'Yearly'}
                {entry === 'year' && yearlySaving && (
                  <span
                    className={cn(
                      'ml-2 rounded-full px-1.5 py-0.5 text-[11px]',
                      interval === 'year' ? 'bg-white/15' : 'bg-success-soft text-success',
                    )}
                  >
                    save {yearlySaving}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          'grid gap-4',
          plans.length >= 4 ? 'md:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-3',
        )}
      >
        {plans.map((plan) => {
          const free =
            !plan.isContactSales && plan.monthlyPriceCents === 0 && plan.annualPriceCents === 0;
          const yearly = interval === 'year' && plan.annualPriceCents > 0;
          const perMonth = yearly ? Math.round(plan.annualPriceCents / 12) : plan.monthlyPriceCents;
          const isHighlighted = plan.id === highlighted;
          return (
            <div
              key={plan.id}
              className={cn(
                'relative flex flex-col rounded-3xl border bg-surface p-6 sm:p-7',
                isHighlighted
                  ? 'border-brand shadow-[0_12px_40px_-16px_rgb(37_99_235/0.45)]'
                  : 'border-border',
              )}
            >
              {isHighlighted && (
                <span className="absolute -top-3 left-6 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-inverted">
                  Most popular
                </span>
              )}
              <h3 className="text-[18px] font-semibold text-ink">{plan.name}</h3>
              {plan.tagline && <p className="mt-1 text-[14px] text-ink-muted">{plan.tagline}</p>}

              <p className="mt-6">
                {plan.isContactSales ? (
                  <span className="text-[34px] font-semibold tracking-tight text-ink">Custom</span>
                ) : free ? (
                  <span className="text-[34px] font-semibold tracking-tight text-ink">Free</span>
                ) : (
                  <>
                    <span className="text-[34px] font-semibold tracking-tight text-ink">
                      {formatMoney(perMonth, plan.currency)}
                    </span>
                    <span className="text-[14px] text-ink-muted"> /month</span>
                  </>
                )}
              </p>
              <p className="mt-1 min-h-[20px] text-[13px] text-ink-subtle">
                {plan.isContactSales
                  ? 'Priced for what you need'
                  : free
                    ? 'No card needed'
                    : yearly
                      ? `${formatMoney(plan.annualPriceCents, plan.currency)} billed yearly`
                      : 'Billed monthly, cancel any time'}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5 text-[14.5px] text-ink">
                <Line on>{limit(plan.maxProperties, 'website', 'websites')}</Line>
                <Line on>{limit(plan.maxMembers, 'team member', 'team members')}</Line>
                <Line on>Unlimited conversations</Line>
                <Line on={plan.aiAgent}>AI agent</Line>
                <Line on={plan.integrations}>API keys &amp; webhooks</Line>
                <Line on={plan.removeBranding}>Remove widget branding</Line>
                {plan.aiOwnKey && <Line on>Your own AI provider key</Line>}
              </ul>

              <Link
                href={plan.isContactSales ? '/contact' : '/register'}
                className={cn(
                  'mt-7 rounded-full px-5 py-3 text-center text-sm font-semibold transition-colors',
                  isHighlighted
                    ? 'bg-brand text-ink-inverted hover:bg-brand-hover'
                    : 'border border-border-strong text-ink hover:bg-surface-raised',
                )}
              >
                {plan.isContactSales
                  ? 'Talk to us'
                  : free
                    ? 'Start free'
                    : `Start with ${plan.name}`}
              </Link>
            </div>
          );
        })}
      </div>

      {!compact && (
        <p className="mx-auto mt-8 max-w-2xl text-center text-[13.5px] leading-relaxed text-ink-subtle">
          Every account starts on the free plan with no card. Upgrade from the Billing page when you
          need more; your plan changes immediately and the difference is prorated. Cancel any time
          and you keep everything until the end of what you paid for.
        </p>
      )}
    </div>
  );
}

function Line({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <li className={cn('flex items-center gap-2.5', !on && 'text-ink-subtle')}>
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
    </li>
  );
}
