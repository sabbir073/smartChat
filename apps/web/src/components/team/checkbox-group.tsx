'use client';

import { cn } from '@/components/ui';

/**
 * A short list of things to tick.
 *
 * Lives in its own module rather than beside the Team page because a Next.js page may only export
 * a default component — anything else it exports is a build error, not a style preference.
 */
export function CheckboxGroup({
  label,
  empty,
  options,
  selected,
  onChange,
}: {
  label: string;
  empty: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) {
    return empty ? <p className="text-[13px] text-ink-subtle">{empty}</p> : null;
  }

  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-ink">{label}</legend>
      <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-[var(--radius-control)] border border-border p-2.5">
        {options.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <label
              key={option.id}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded px-1.5 py-1 text-[13px]',
                checked ? 'text-ink' : 'text-ink-muted',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                className="size-4"
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((entry) => entry !== option.id),
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
