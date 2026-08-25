'use client';

import { useEffect } from 'react';
import { BrandMark } from '@/components/layout/brand-mark';

/**
 * Route-level error boundary.
 *
 * Without this, Next falls back to the legacy `_error` page, which is both an uglier experience
 * and the source of a confusing `<Html> should not be imported outside of pages/_document` build
 * failure. The digest is shown because it is the only handle a person has when reporting a
 * problem - the underlying message is deliberately not exposed to the browser.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error in the dashboard', error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <BrandMark />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Something went wrong</h1>
        <p className="max-w-sm text-sm text-ink-muted">
          This page could not be displayed. Trying again often resolves it; if it keeps happening,
          the reference below will help us find the cause.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-[12px] text-ink-subtle">Reference: {error.digest}</p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-[var(--radius-control)] bg-brand px-4 py-2.5 text-sm font-medium text-ink-inverted hover:bg-brand-hover"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded-[var(--radius-control)] border border-border-strong bg-surface px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface-raised"
        >
          Back to the dashboard
        </a>
      </div>
    </div>
  );
}
