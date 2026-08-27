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
  permissions: string[];
  role: string | null;
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: CurrentUser | null;
  /**
   * What this person may do in the active account, for deciding what to *render*.
   *
   * Never for deciding what is allowed - the API re-derives every permission on every request.
   * Its job here is to stop the dashboard offering a button that answers 403 when pressed.
   */
  can(permission: string): boolean;
  role: string | null;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | null;
  refresh(): Promise<void>;
  switchAccount(accountId: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Expire the session cookie in the browser.
 *
 * It is deliberately not HttpOnly-dependent: this only needs to remove the *routing* signal the
 * middleware reads. The server-side session is already gone, which is why we are here.
 */
function clearSessionCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = 'sc_session=; path=/; max-age=0; SameSite=Lax';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(() => new Set());
  const [role, setRole] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<MeResponse>('/auth/me');
      setUser(data.user);
      setAccounts(data.accounts);
      setActiveAccountId(data.activeAccountId ?? data.accounts[0]?.id ?? null);
      setPermissions(new Set(data.permissions ?? []));
      setRole(data.role ?? null);
      setStatus('authenticated');
    } catch (error) {
      // Any authentication failure means "not signed in" here; the API is the authority and has
      // already decided. Anything else is surfaced by the calling screen.
      if (error instanceof ApiError && error.isUnauthenticated) {
        setUser(null);
        setAccounts([]);
        setActiveAccountId(null);
        setPermissions(new Set());
        setRole(null);
        setStatus('anonymous');

        /**
         * Drop the dead cookie and go to sign-in.
         *
         * The middleware routes on the *presence* of a session cookie, not its validity - it
         * cannot check that. So a cookie the API has rejected leaves somebody stranded: every
         * page says "your session has expired, please sign in again", and /login redirects them
         * straight back out because the cookie is still there. Clearing it here is what makes
         * that message actionable.
         */
        clearSessionCookie();
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          router.replace('/login?expired=1');
        }
        return;
      }
      setStatus('anonymous');
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchAccount = useCallback(
    async (accountId: string) => {
      await api.post('/auth/switch-account', { accountId });
      setActiveAccountId(accountId);
      // Permissions are per-account, so they have to be re-read rather than carried across.
      await refresh();
      router.refresh();
    },
    [refresh, router],
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
      can: (permission: string) => permissions.has(permission),
      role,
      refresh,
      switchAccount,
      signOut,
    }),
    [status, user, accounts, activeAccountId, permissions, role, refresh, switchAccount, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
