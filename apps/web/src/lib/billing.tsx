'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api-client';
import { useAuth } from './auth-context';

/**
 * What the shell needs to know about billing: is this account locked, and is a warning due.
 *
 * Fetched once per account and refreshed on demand (after a checkout returns, after a plan
 * change), rather than on every navigation: the API enforces the lock on every write whatever
 * this says, so a stale "unlocked" here costs one clear error message and nothing more.
 */

export type LockReason = 'unpaid' | 'canceled' | 'grace_expired' | 'incomplete' | 'over_limit';

export interface EntitlementsDto {
  plan: {
    id: string;
    key: string;
    name: string;
    maxProperties: number | null;
    maxMembers: number | null;
    aiAgent: boolean;
    integrations: boolean;
    removeBranding: boolean;
    aiOwnKey: boolean;
    isContactSales: boolean;
  };
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  usage: { properties: number; members: number };
  lock: { locked: boolean; reason: LockReason | null; graceEndsAt: string | null };
}

interface BillingContextValue {
  entitlements: EntitlementsDto | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const BillingContext = createContext<BillingContextValue | null>(null);

export function BillingProvider({ children }: { children: ReactNode }) {
  const { status, activeAccount } = useAuth();
  const [entitlements, setEntitlements] = useState<EntitlementsDto | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (status !== 'authenticated' || !activeAccount) return;
    try {
      const result = await api.get<EntitlementsDto>('/billing/entitlements');
      setEntitlements(result.data);
    } catch {
      // Left as it was. The API is the authority on the lock; a failed read here only means the
      // banner may be a refresh behind.
    } finally {
      setLoading(false);
    }
  }, [status, activeAccount]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(() => ({ entitlements, loading, reload }), [entitlements, loading, reload]);
  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  const value = useContext(BillingContext);
  if (!value) throw new Error('useBilling must be used inside BillingProvider');
  return value;
}

/** One sentence for a lock reason, matching what the API says in its error. */
export function lockMessage(reason: LockReason): string {
  switch (reason) {
    case 'unpaid':
    case 'grace_expired':
      return 'Your subscription is unpaid. Update your payment method to keep working.';
    case 'canceled':
      return 'Your subscription has ended. Choose a plan to continue.';
    case 'incomplete':
      return 'Your first payment did not go through. Choose a plan to continue.';
    case 'over_limit':
      return 'Your account has more websites or team members than your plan includes. Remove some, or choose a bigger plan.';
  }
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
