import type { ReactNode } from 'react';

/**
 * Shared shell for the two legal pages.
 *
 * Both carry a visible "this is a template" notice, and that notice is not decoration: shipping
 * confident-sounding legal text that nobody has reviewed is worse than shipping none, because the
 * confident version is what gets deployed and forgotten. This says plainly what it is, so whoever
 * runs this deployment knows there is a job to do before launch.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <h1 className="text-[32px] font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-2 text-[13px] text-ink-subtle">Last updated {updated}</p>

      <div className="mt-6 rounded-[var(--radius-card)] border border-warning/40 bg-warning-soft px-5 py-4">
        <p className="text-[13px] font-semibold text-ink">This is a template, not legal advice.</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          SmartChat is self-hosted, so this page describes how the software behaves rather than the
          terms of any particular deployment. Whoever operates this installation should have it
          reviewed and replaced before taking real customers.
        </p>
      </div>

      <div className="mt-10 space-y-8">{children}</div>
    </div>
  );
}

export function Clause({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}
