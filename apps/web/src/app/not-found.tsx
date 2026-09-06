import Link from 'next/link';
import { BrandMark } from '@/components/layout/brand-mark';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <BrandMark />
      <div className="space-y-2">
        <p className="text-[13px] font-medium uppercase tracking-wide text-ink-subtle">404</p>
        <h1 className="text-xl font-semibold tracking-tight text-ink">This page does not exist</h1>
        <p className="max-w-sm text-sm text-ink-muted">
          The link may be out of date, or the workspace it belonged to may no longer be yours.
        </p>
      </div>
      {/*
        Two ways out, because this page is reachable from both halves of the site: a stranger who
        mistyped a marketing URL and a signed-in person whose link went stale. One button pointing
        at the dashboard sent the first of those to a sign-in screen for no reason.
      */}
      <div className="flex flex-wrap justify-center gap-2">
        <Link
          href="/"
          className="rounded-[var(--radius-control)] bg-brand px-4 py-2.5 text-sm font-medium text-ink-inverted hover:bg-brand-hover"
        >
          Go to the homepage
        </Link>
        <Link
          href="/app"
          className="rounded-[var(--radius-control)] border border-border-strong bg-surface px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface-raised"
        >
          Open the dashboard
        </Link>
      </div>
    </div>
  );
}
