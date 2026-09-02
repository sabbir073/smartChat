'use client';

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Sidebar } from '@/components/layout/sidebar';
import { SubscriptionBanner } from '@/components/layout/subscription-banner';
import { Topbar } from '@/components/layout/topbar';
import { Spinner } from '@/components/ui';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  // The middleware has already redirected anyone without a session cookie, so this only covers
  // the moment between mount and the /auth/me response.
  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6 text-ink-subtle" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop navigation */}
      <aside className="hidden border-r border-border bg-surface lg:sticky lg:top-0 lg:block lg:h-dvh">
        <Sidebar />
      </aside>

      {/* Mobile navigation */}
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 cursor-default bg-ink/25"
            tabIndex={-1}
          />
          <aside className="relative h-full w-64 border-r border-border bg-surface">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        <SubscriptionBanner />
        <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
