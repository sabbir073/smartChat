import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';

/**
 * The marketing site's building blocks.
 *
 * Server components with no state, so every page renders fully without JavaScript. They exist so
 * the pages read as content rather than as a wall of utility classes - and so a spacing decision
 * is made once here instead of drifting across seven files.
 */

export function Section({
  children,
  className,
  tone = 'canvas',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'canvas' | 'surface';
}) {
  return (
    <section className={cn(tone === 'surface' ? 'bg-surface' : 'bg-canvas', className)}>
      <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-brand">{children}</p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  centered = false,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  centered?: boolean;
}) {
  return (
    <div className={cn('max-w-2xl', centered && 'mx-auto text-center')}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="mt-2 text-balance text-[28px] font-semibold leading-tight tracking-tight text-ink sm:text-[34px]">
        {title}
      </h2>
      {lead && <p className="mt-4 text-[16px] leading-relaxed text-ink-muted">{lead}</p>}
    </div>
  );
}

export function FeatureCard({
  title,
  children,
  icon,
}: {
  title: string;
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div
        aria-hidden
        className="grid size-9 place-items-center rounded-[var(--radius-control)] bg-brand-soft text-brand"
      >
        {icon}
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{children}</p>
    </div>
  );
}

/** A numbered step. Used by "how it works", where the order is the point. */
export function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="relative pl-12">
      <span
        aria-hidden
        className="absolute left-0 top-0 grid size-8 place-items-center rounded-full border border-border-strong bg-surface text-[13px] font-semibold text-ink"
      >
        {number}
      </span>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">{children}</p>
    </li>
  );
}

export function CallToAction({
  title,
  lead,
  primary = { href: '/register', label: 'Start free' },
  secondary,
}: {
  title: string;
  lead: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface px-6 py-10 text-center sm:px-10">
      <h2 className="text-balance text-[24px] font-semibold tracking-tight text-ink sm:text-[28px]">
        {title}
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-ink-muted">{lead}</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={primary.href}
          className="rounded-[var(--radius-control)] bg-brand px-5 py-2.5 text-sm font-medium text-ink-inverted shadow-sm transition-colors hover:bg-brand-hover"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="rounded-[var(--radius-control)] border border-border-strong px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-raised"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Small line-art icons, inline so the pages need no icon dependency and no extra request. */
export const icons = {
  inbox: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 13h4l2 3h6l2-3h4M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2-8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  bolt: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  ),
  book: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm0 0v14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  ticket: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a3 3 0 0 0 0 6v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a3 3 0 0 0 0-6V8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  chart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 20V10m6 10V4m6 16v-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3 5 6v6c0 4.2 2.9 7.8 7 9 4.1-1.2 7-4.8 7-9V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  plug: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Zm6 12v2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  users: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-3.3 2.7-5 6-5s6 1.7 6 5m2-5c2.8.3 4 2 4 5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};
