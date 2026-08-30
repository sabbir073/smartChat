'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { BrandMark } from './brand-mark';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Navigation for a phase that is not built yet is not shown at all - never as a dead link. */
  available: boolean;
}

const icon = (path: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-[18px] shrink-0"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

const NAV: NavItem[] = [
  {
    href: '/',
    label: 'Overview',
    available: true,
    icon: icon('M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z'),
  },
  {
    href: '/inbox',
    label: 'Inbox',
    available: true,
    icon: icon(
      'M3 8.5 12 3l9 5.5M3 8.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5M3 8.5l8 5a2 2 0 0 0 2 0l8-5',
    ),
  },
  {
    href: '/properties',
    label: 'Websites',
    available: true,
    icon: icon(
      'M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18ZM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    ),
  },
  {
    href: '/team',
    label: 'Team',
    available: true,
    icon: icon(
      'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M13 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
    ),
  },
  {
    href: '/contacts',
    label: 'Contacts',
    available: true,
    icon: icon(
      'M17 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 6 18.5V20M14.5 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    ),
  },
  {
    href: '/automation',
    label: 'Automation',
    available: true,
    icon: icon(
      'M13 3 4 14h6l-1 7 9-11h-6l1-7Z',
    ),
  },
  {
    href: '/settings',
    label: 'Settings',
    available: true,
    icon: icon(
      'M10.3 3.6a1.4 1.4 0 0 1 1.3-1h.8a1.4 1.4 0 0 1 1.3 1l.2.9a7.6 7.6 0 0 1 1.6.9l.9-.3a1.4 1.4 0 0 1 1.6.6l.4.7a1.4 1.4 0 0 1-.3 1.7l-.7.6a7.6 7.6 0 0 1 0 1.8l.7.6a1.4 1.4 0 0 1 .3 1.7l-.4.7a1.4 1.4 0 0 1-1.6.6l-.9-.3a7.6 7.6 0 0 1-1.6.9l-.2.9a1.4 1.4 0 0 1-1.3 1h-.8a1.4 1.4 0 0 1-1.3-1l-.2-.9a7.6 7.6 0 0 1-1.6-.9l-.9.3a1.4 1.4 0 0 1-1.6-.6l-.4-.7a1.4 1.4 0 0 1 .3-1.7l.7-.6a7.6 7.6 0 0 1 0-1.8l-.7-.6a1.4 1.4 0 0 1-.3-1.7l.4-.7a1.4 1.4 0 0 1 1.6-.6l.9.3a7.6 7.6 0 0 1 1.6-.9l.2-.9ZM14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
    ),
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Main">
      <div className="mb-3 px-2 pt-1">
        <BrandMark />
      </div>

      {NAV.filter((item) => item.available).map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-brand-soft text-brand'
                : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
            )}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}

      <div className="mt-auto rounded-[var(--radius-control)] bg-surface-raised p-3 text-[12px] leading-relaxed text-ink-subtle">
        The knowledge base, tickets and reporting arrive in later phases. Nothing is listed here
        before it works.
      </div>
    </nav>
  );
}
