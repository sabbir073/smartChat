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
import { useRouter } from 'next/navigation';
import { ApiError, api } from './api-client';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  timezone: string;
  locale: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  status: string;
}

interface MeResponse {
  user: CurrentUser;
  accounts: AccountSummary[];
  activeAccountId: string | null;
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: CurrentUser | null;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | null;
  refresh(): Promise<void>;
  switchAccount(accountId: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<MeResponse>('/auth/me');
      setUser(data.user);
      setAccounts(data.accounts);
      setActiveAccountId(data.activeAccountId ?? data.accounts[0]?.id ?? null);
      setStatus('authenticated');
    } catch (error) {
      // Any authentication failure means "not signed in" here; the API is the authority and has
      // already decided. Anything else is surfaced by the calling screen.
      if (error instanceof ApiError && error.isUnauthenticated) {
        setUser(null);
        setAccounts([]);
        setActiveAccountId(null);
        setStatus('anonymous');
        return;
      }
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchAccount = useCallback(
    async (accountId: string) => {
      await api.post('/auth/switch-account', { accountId });
      setActiveAccountId(accountId);
      router.refresh();
    },
    [router],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      setAccounts([]);
      setStatus('anonymous');
      router.replace('/login');
    }
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      accounts,
      activeAccount:
        accounts.find((account) => account.id === activeAccountId) ?? accounts[0] ?? null,
      refresh,
      switchAccount,
      signOut,
    }),
    [status, user, accounts, activeAccountId, refresh, switchAccount, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
