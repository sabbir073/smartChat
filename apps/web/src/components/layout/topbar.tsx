'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Button, cn } from '@/components/ui';

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { user, accounts, activeAccount, switchAccount, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = (user?.name ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur">
      <button
        type="button"
        onClick={onOpenNav}
        className="-ml-1 rounded-[var(--radius-control)] p-2 text-ink-muted hover:bg-surface-raised lg:hidden"
        aria-label="Open navigation"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-5"
        >
          <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
        </svg>
      </button>

      {accounts.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Active workspace</span>
          <select
            value={activeAccount?.id ?? ''}
            onChange={(event) => void switchAccount(event.target.value)}
            className="h-8 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-sm font-medium text-ink"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="text-sm font-medium text-ink">{activeAccount?.name ?? ''}</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {user && !user.emailVerified && (
          <a
            href="/verify-email"
            className="hidden rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-[12px] font-medium text-ink sm:block"
          >
            Verify your email
          </a>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-surface-raised"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-ink-inverted">
              {initials}
            </span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="size-3.5 text-ink-subtle"
            >
              <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {menuOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-10 cursor-default"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                tabIndex={-1}
              />
              <div
                role="menu"
                className={cn(
                  'absolute right-0 z-20 mt-2 w-60 rounded-[var(--radius-card)] border border-border',
                  'bg-surface p-1.5 shadow-lg',
                )}
              >
                <div className="border-b border-border px-2.5 py-2">
                  <p className="truncate text-sm font-medium text-ink">{user?.name}</p>
                  <p className="truncate text-[12px] text-ink-subtle">{user?.email}</p>
                </div>
                <div className="p-1">
                  <Button variant="ghost" size="sm" fullWidth onClick={() => void signOut()}>
                    Sign out
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
