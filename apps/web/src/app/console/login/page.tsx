'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api-client';

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

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/platform/auth/login', { email, password });
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
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1.5 h-10 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 text-sm text-ink-inverted"
          />
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
