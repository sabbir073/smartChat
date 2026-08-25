'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui';

export function ControlGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-5 py-4 last:border-b-0">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">{title}</h3>
      {description && <p className="mt-1 text-[13px] text-ink-muted">{description}</p>}
      <div className="mt-3 space-y-3.5">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-subtle">{hint}</span>}
    </label>
  );
}

export function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Row label={label}>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="size-9 shrink-0 cursor-pointer rounded-[var(--radius-control)] border border-border-strong bg-surface p-1"
          aria-label={`${label} colour picker`}
        />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-9 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-2.5 font-mono text-[13px] uppercase text-ink"
          maxLength={7}
          spellCheck={false}
          aria-label={`${label} hex value`}
        />
      </span>
    </Row>
  );
}

export function SliderControl({
  label,
  value,
  min,
  max,
  suffix = 'px',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Row label={label}>
      <span className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-1.5 w-full cursor-pointer accent-[var(--color-brand)]"
          aria-label={label}
        />
        <span className="w-14 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink-muted">
          {value}
          {suffix}
        </span>
      </span>
    </Row>
  );
}

export function ToggleControl({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[12px] text-ink-subtle">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-surface shadow-sm transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

export function PositionControl({
  value,
  onChange,
}: {
  value: 'bottom_right' | 'bottom_left' | 'top_right' | 'top_left';
  onChange: (value: 'bottom_right' | 'bottom_left' | 'top_right' | 'top_left') => void;
}) {
  const options = [
    { value: 'top_left', label: 'Top left' },
    { value: 'top_right', label: 'Top right' },
    { value: 'bottom_left', label: 'Bottom left' },
    { value: 'bottom_right', label: 'Bottom right' },
  ] as const;

  return (
    <Row label="Position">
      <span className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              'rounded-[var(--radius-control)] border px-3 py-2 text-[13px] font-medium transition-colors',
              value === option.value
                ? 'border-brand bg-brand-soft text-brand'
                : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-raised',
            )}
          >
            {option.label}
          </button>
        ))}
      </span>
    </Row>
  );
}
