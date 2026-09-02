'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface Overview {
  status: string;
  isPaused: boolean;
  graceEndsAt: string | null;
  trialEndsAt: string | null;
  plan: { name: string };
  usage: { key: string; used: number; limit: number | null; over: boolean }[];
}

/**
 * The state of the subscription, on every screen.
 *
 * "Pause, never destroy" only works if the customer is told. An account whose widget quietly
 * stopped taking chats, or whose fourth website is outside a plan that covers three, finds out
 * from an angry visitor unless this is here - and by then the damage is somebody else's trust,
 * not ours. So the banner sits in the shell rather than on the billing page, where it would only
 * be read by somebody who already suspected something.
 *
 * It renders nothing at all in the ordinary case. A permanent strip of chrome that says "you are
 * fine" trains people to stop reading the strip.
 */
export function SubscriptionBanner() {
  const { activeAccount } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOverview(null);
    void api
      .get<Overview>('/billing/subscription', { signal: controller.signal })
      // A billing read that fails must never blank the dashboard. Silence is the right failure.
      .catch(() => null)
      .then((result) => setOverview(result?.data ?? null));
    return () => controller.abort();
  }, [activeAccount?.id]);

  if (!overview) return null;

  const over = overview.usage.filter((line) => line.over);
  const message = describe(overview, over.length);
  if (!message) return null;

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-[13px] sm:px-6 ${
        message.severe
          ? 'border-danger/25 bg-danger-soft text-ink'
          : 'border-warning/30 bg-warning-soft text-ink'
      }`}
    >
      <span>{message.text}</span>
      <Link
        href="/app/settings/billing"
        className="shrink-0 font-medium text-brand underline underline-offset-2"
      >
        {message.action}
      </Link>
    </div>
  );
}

function describe(
  overview: Overview,
  overCount: number,
): { text: string; action: string; severe: boolean } | null {
  if (overview.isPaused) {
    return {
      severe: true,
      action: 'Restore service',
      text:
        'This account is read-only: chat widgets are not taking new conversations. ' +
        'Nothing has been deleted, and everything comes back when the subscription is renewed.',
    };
  }

  if (overview.status === 'past_due') {
    const until = overview.graceEndsAt
      ? new Date(overview.graceEndsAt).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
        })
      : null;
    return {
      severe: false,
      action: 'View invoices',
      text: until
        ? `Payment for the current period has not been recorded. Service continues until ${until}.`
        : 'Payment for the current period has not been recorded.',
    };
  }

  if (overCount > 0) {
    return {
      severe: false,
      action: 'See what changed',
      text:
        overCount === 1
          ? `One thing is over what ${overview.plan.name} includes. Nothing was deleted - the excess is read-only.`
          : `${overCount} things are over what ${overview.plan.name} includes. Nothing was deleted - the excess is read-only.`,
    };
  }

  return null;
}
