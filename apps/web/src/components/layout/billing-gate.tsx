'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { formatDate, lockMessage, useBilling } from '@/lib/billing';
import { Alert, Button } from '@/components/ui';

/**
 * The billing lock, as the dashboard shows it.
 *
 * Locked: every page except Billing itself is replaced by a wall that says why and where to go.
 * The API refuses the writes regardless; the wall exists so nobody finds out by having a reply
 * fail. Past due but inside the grace window: the page renders as normal under a banner with the
 * date the lock lands.
 *
 * Only owners and admins can fix either, so the copy says who to talk to when the reader cannot.
 */
export function BillingGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { entitlements } = useBilling();
  const { can } = useAuth();
  const onBillingPage = pathname.startsWith('/app/billing');
  const canManage = can('billing:manage');

  if (!entitlements) return <>{children}</>;

  const { lock, subscription } = entitlements;

  if (lock.locked && lock.reason && !onBillingPage) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-lg rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-6"
              aria-hidden="true"
            >
              <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-ink">Your dashboard is locked</h1>
          <p className="mt-2 text-sm text-ink-muted">{lockMessage(lock.reason)}</p>
          <p className="mt-2 text-[13px] text-ink-subtle">
            Nothing has been deleted, and your chat widget is still live for your visitors. You can
            read everything; changes and replies wait until this is resolved.
          </p>
          <div className="mt-6">
            {canManage ? (
              <Link href="/app/billing">
                <Button>Go to billing</Button>
              </Link>
            ) : (
              <p className="text-sm text-ink-muted">
                Ask an owner or admin of this workspace to sort it out from the Billing page.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const pastDue = subscription.status === 'past_due' && !lock.locked;

  return (
    <>
      {pastDue && !onBillingPage && (
        <Alert tone="warning" title="Your last payment failed" className="mb-4">
          {lock.graceEndsAt
            ? `We'll keep trying your card. If it isn't sorted by ${formatDate(lock.graceEndsAt)}, the dashboard will be locked until it is. `
            : 'Update your payment method to keep working. '}
          {canManage && (
            <Link href="/app/billing" className="font-medium text-brand hover:underline">
              Update payment method
            </Link>
          )}
        </Alert>
      )}
      {children}
    </>
  );
}
