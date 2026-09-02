'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/components/ui';

const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

/** The wordmark, used in both the header and the footer. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold text-ink', className)}>
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-[10px] bg-gradient-to-br from-brand via-accent-violet to-accent-cyan text-[14px] font-bold text-ink-inverted shadow-sm"
      >
        S
      </span>
      SmartChat
    </span>
  );
}

/**
 * The marketing header.
 *
 * A client component only because of the mobile menu toggle. The pages themselves are server
 * components, so the marketing site renders and is readable with no JavaScript at all - which
 * matters here more than in the dashboard: this is the page a search engine and a person on a
 * train both have to be able to read.
 */
export function MarketingHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  /**
   * The header condenses once the hero is behind it.
   *
   * Passive listener and a boolean, rather than anything that reads layout on every frame: this
   * fires on every scroll event on every page of the site, and the one thing it must not do is
   * make scrolling feel worse than it did without it.
   */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 transition-all duration-300',
        scrolled
          ? 'border-b border-border bg-surface/80 shadow-[0_1px_20px_-12px_rgba(0,0,0,0.35)] backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <div
        className={cn(
          'mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 transition-all duration-300',
          scrolled ? 'h-14' : 'h-[72px]',
        )}
      >
        <Link href="/" className="shrink-0" aria-label="SmartChat home">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={cn(
                'group relative px-3 py-2 text-sm font-medium transition-colors',
                pathname === item.href ? 'text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {item.label}
              {/* Grows from the centre on hover, and sits full-width on the current page. */}
              <span
                aria-hidden
                className={cn(
                  'absolute inset-x-3 -bottom-0.5 h-0.5 origin-center rounded-full bg-gradient-to-r from-brand to-accent-violet transition-transform duration-300',
                  pathname === item.href ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100',
                )}
              />
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href="/login"
            className="rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="rounded-full bg-gradient-to-r from-brand to-accent-violet px-5 py-2 text-sm font-semibold text-ink-inverted shadow-sm shadow-brand/25 transition-transform hover:scale-[1.04]"
          >
            Start free
          </Link>
        </div>

        <button
          type="button"
          className="rounded-[var(--radius-control)] border border-border-strong p-2 md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="border-t border-border bg-surface px-5 py-3 md:hidden"
        >
          <ul className="space-y-1">
            {[...NAV, { href: '/login', label: 'Sign in' }].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="pt-1">
              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="block rounded-full bg-gradient-to-r from-brand to-accent-violet px-3 py-2.5 text-center text-sm font-semibold text-ink-inverted"
              >
                Start free
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-ink-muted">
              Live chat you host yourself. One inbox for every website you run, and no per-seat
              surprise on the invoice.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { href: '/features', label: 'Features' },
              { href: '/pricing', label: 'Pricing' },
              { href: '/register', label: 'Start free' },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { href: '/about', label: 'About' },
              { href: '/contact', label: 'Contact' },
            ]}
          />
          <FooterColumn
            title="Legal"
            links={[
              { href: '/terms', label: 'Terms' },
              { href: '/privacy', label: 'Privacy' },
            ]}
          />
        </div>

        <p className="mt-10 border-t border-border pt-6 text-[12px] text-ink-subtle">
          © {new Date().getFullYear()} SmartChat. Self-hosted live chat.
        </p>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-[13px] text-ink-muted hover:text-ink">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
