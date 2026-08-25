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
      <Link
        href="/"
        className="rounded-[var(--radius-control)] bg-brand px-4 py-2.5 text-sm font-medium text-ink-inverted hover:bg-brand-hover"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}
