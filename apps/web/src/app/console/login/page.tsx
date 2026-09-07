'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, browserKeptSession } from '@/lib/api-client';

/**
 * Signing in to the platform console.
 *
 * No "create an account", no "forgot your password", no "remember me". A platform administrator is
 * created by somebody with database access, and every convenience the dashboard offers would be
 * another door on the most privileged credential in the system.
 */
export default function ConsoleLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/platform/auth/login', { email, password });
      // Same reasoning as the dashboard's sign-in: a session this browser did not keep produces a
      // redirect straight back to here with nothing said. See `browserKeptSession`.
      if (!browserKeptSession()) {
        setError(
          'Signed in, but your browser did not keep the session. Check that cookies are allowed for this site, then try again.',
        );
        return;
      }
      router.push('/console');
    } catch (caught) {
      // The server's own wording. It says the same thing for a wrong password, an unknown
      // address and a locked account, which is the point.
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <p className="text-[13px] font-medium uppercase tracking-wide text-ink-inverted/50">
        SmartChat
      </p>
      <h1 className="mt-1 text-[26px] font-semibold">Platform console</h1>
      <p className="mt-2 text-sm text-ink-inverted/60">
        For operators of this installation. Not for account holders.
      </p>

      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        {error && (
          <p className="rounded-[var(--radius-control)] bg-danger/20 px-3 py-2 text-[13px] text-danger-soft">
            {error}
          </p>
        )}
        <label className="block">
          <span className="text-[13px] font-medium text-ink-inverted/70">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1.5 h-10 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 text-sm text-ink-inverted"
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium text-ink-inverted/70">Password</span>
          {/* The console keeps its own dark styling rather than the dashboard's controls, so the
              reveal button is written out here instead of reusing PasswordInput. Same behaviour:
              type="button" so it cannot submit, labelled for a screen reader, out of the tab
              order between the field and the submit button. */}
          <span className="relative mt-1.5 block">
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 pl-3 pr-11 text-sm text-ink-inverted"
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              tabIndex={-1}
              className="absolute inset-y-0 right-0 grid w-11 place-items-center text-ink-inverted/50 transition-colors hover:text-ink-inverted"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.2 12S5.8 5.5 12 5.5 21.8 12 21.8 12 18.2 18.5 12 18.5 2.2 12 2.2 12Z" />
                <circle cx="12" cy="12" r="3" />
                {showPassword && <path d="M3.5 3.5l17 17" />}
              </svg>
            </button>
          </span>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="h-10 w-full rounded-[var(--radius-control)] bg-brand text-sm font-medium text-ink-inverted disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
