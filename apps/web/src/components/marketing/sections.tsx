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
  backdrop,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  /** `night` is the dark band product visuals sit on, where a glow has something to glow against. */
  tone?: 'canvas' | 'surface' | 'night';
  /** Decorative backdrop. Purely visual; nothing below it depends on it rendering. */
  backdrop?: 'aurora' | 'grid' | 'both';
  wide?: boolean;
}) {
  const night = tone === 'night';
  return (
    <section
      className={cn(
        'relative',
        night && 'bg-night text-ink-inverted',
        tone === 'surface' && 'bg-surface',
        tone === 'canvas' && 'bg-canvas',
        (backdrop === 'aurora' || backdrop === 'both') && 'mk-aurora',
        (backdrop === 'aurora' || backdrop === 'both') && night && 'mk-aurora--night',
        (backdrop === 'grid' || backdrop === 'both') && 'mk-grid',
        (backdrop === 'grid' || backdrop === 'both') && night && 'mk-grid--night',
        className,
      )}
    >
      <div className={cn('relative mx-auto px-5 py-16 sm:py-24', wide ? 'max-w-7xl' : 'max-w-6xl')}>
        {children}
      </div>
    </section>
  );
}

export function Eyebrow({ children, night = false }: { children: ReactNode; night?: boolean }) {
  return (
    <p
      className={cn(
        'inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em]',
        night ? 'text-accent-cyan' : 'text-brand',
      )}
    >
      <span
        aria-hidden
        className={cn('h-px w-6', night ? 'bg-accent-cyan/60' : 'bg-brand/40')}
      />
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  centered = false,
  night = false,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  centered?: boolean;
  night?: boolean;
}) {
  return (
    <div className={cn('max-w-2xl', centered && 'mx-auto text-center')}>
      {eyebrow && <Eyebrow night={night}>{eyebrow}</Eyebrow>}
      <h2
        className={cn(
          'mt-3 text-balance text-[30px] font-semibold leading-[1.12] tracking-tight sm:text-[40px]',
          night ? 'text-ink-inverted' : 'text-ink',
        )}
      >
        {title}
      </h2>
      {lead && (
        <p
          className={cn(
            'mt-4 text-[16.5px] leading-relaxed',
            night ? 'text-ink-inverted/70' : 'text-ink-muted',
          )}
        >
          {lead}
        </p>
      )}
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
    <div className="mk-card group h-full p-5">
      <div
        aria-hidden
        className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent-violet text-ink-inverted shadow-sm transition-transform duration-300 group-hover:scale-105"
      >
        {icon}
      </div>
      <h3 className="mt-4 text-[15.5px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{children}</p>
    </div>
  );
}

/**
 * A statement of fact about the product, sized to be read across a room.
 *
 * Only ever facts we can point at in the code - a plan limit, a delivery guarantee, a schedule.
 * Never a customer count, an uptime figure or a satisfaction score: this deployment has no
 * customers yet, and a number nobody can check is an invented one.
 */
export function Figure({
  value,
  label,
  night = false,
}: {
  value: string;
  label: string;
  night?: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          'text-[30px] font-semibold tracking-tight sm:text-[36px]',
          night ? 'mk-gradient-text--bright' : 'text-ink',
        )}
      >
        {value}
      </p>
      <p className={cn('mt-1 text-[13px]', night ? 'text-ink-inverted/60' : 'text-ink-muted')}>
        {label}
      </p>
    </div>
  );
}

/** A pill of running text. Used in the marquee, where each one names something real. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="mx-1.5 inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-[13px] font-medium text-ink-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-gradient-to-br from-brand to-accent-violet" />
      {children}
    </span>
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
    <li className="relative pl-14">
      {/*
        The connector is drawn on the step, not between steps, and hidden on the last one via
        `last:hidden` - so adding a fourth step needs no change here and cannot leave a line
        dangling into nothing.
      */}
      <span
        aria-hidden
        className="absolute left-[19px] top-11 hidden h-[calc(100%-1rem)] w-px bg-gradient-to-b from-brand/40 to-transparent last:hidden sm:block"
      />
      <span
        aria-hidden
        className="absolute left-0 top-0 grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent-violet text-[14px] font-semibold text-ink-inverted shadow-sm"
      >
        {number}
      </span>
      <h3 className="pt-1.5 text-[16px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-muted">{children}</p>
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
    <div className="mk-aurora mk-aurora--night relative overflow-hidden rounded-3xl bg-night px-6 py-14 text-center sm:px-10">
      <h2 className="relative text-balance text-[28px] font-semibold tracking-tight text-ink-inverted sm:text-[34px]">
        {title}
      </h2>
      <p className="relative mx-auto mt-3 max-w-xl text-[15.5px] leading-relaxed text-ink-inverted/70">
        {lead}
      </p>
      <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={primary.href}
          className="rounded-full bg-ink-inverted px-6 py-3 text-sm font-semibold text-ink shadow-lg transition-transform hover:scale-[1.03]"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="rounded-full border border-white/25 px-6 py-3 text-sm font-medium text-ink-inverted transition-colors hover:bg-white/10"
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
