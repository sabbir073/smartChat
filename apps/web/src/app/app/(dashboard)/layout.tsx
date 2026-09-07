'use client';

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Sidebar } from '@/components/layout/sidebar';
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
    /**
     * The shell owns the viewport height; the regions inside it scroll.
     *
     * It used to be `min-h-dvh` with the page scrolling as a whole, which works for a document and
     * not for an inbox. A screen that has to fill the window then has to *guess* how much of the
     * window everything else took — the inbox subtracted a hardcoded `7.5rem` for the top bar and
     * the main padding, which was both wrong (it over-subtracted by 16px) and brittle (a top bar
     * that wraps to two lines on a narrow window makes it wrong in the other direction).
     *
     * With a real height here, a page that wants to fill says `flex-1` and means it.
     */
    <div className="flex h-dvh flex-col overflow-hidden lg:grid lg:grid-cols-[248px_1fr] lg:flex-row">
      {/* Desktop navigation */}
      <aside className="hidden overflow-y-auto border-r border-border bg-surface lg:block lg:h-dvh">
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        {/*
          `min-h-0` is the load-bearing class: without it a flex child refuses to shrink below its
          content, so `overflow-y-auto` here would never actually scroll and a tall page would push
          the shell past the viewport instead.

          A flex column rather than a plain block, so a child can say `flex-1` and fill the window.
          Ordinary pages stack and scroll exactly as before.
        */}
        <main
          id="main"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8"
        >
          {/* `min-h-0` here too. Without it this wrapper keeps its content's height, grows past
              the window, and puts the scrollbar back on the page - which undoes the whole thing
              one element below where you would look for it. */}
          <div className="mx-auto flex w-full min-h-0 max-w-6xl flex-1 flex-col">{children}</div>
        </main>
      </div>
    </div>
  );
}
