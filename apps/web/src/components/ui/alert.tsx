import type { ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  info: 'bg-brand-soft text-ink border-brand/20',
  success: 'bg-success-soft text-ink border-success/25',
  warning: 'bg-warning-soft text-ink border-warning/30',
  danger: 'bg-danger-soft text-ink border-danger/25',
};

const ICONS: Record<Tone, string> = {
  info: 'M12 16v-5m0-3.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  success: 'M8.5 12.5 11 15l4.5-5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  warning:
    'M12 9v4m0 3h.01M10.3 4.3 2.6 17.5A1.9 1.9 0 0 0 4.3 20.4h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z',
  danger: 'M12 8v5m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      // Errors are announced immediately; anything else waits for a pause in the reader's output.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-sm',
        TONES[tone],
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          'mt-0.5 size-[18px] shrink-0',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'info' && 'text-brand',
        )}
        aria-hidden="true"
      >
        <path d={ICONS[tone]} />
      </svg>
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-ink-muted leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}
