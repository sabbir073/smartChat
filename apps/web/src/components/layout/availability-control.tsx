'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { cn } from '@/components/ui';

type Availability = 'online' | 'away' | 'offline';

const OPTIONS: { value: Availability; label: string; dot: string }[] = [
  { value: 'online', label: 'Online', dot: 'bg-success' },
  { value: 'away', label: 'Away', dot: 'bg-warning' },
  { value: 'offline', label: 'Offline', dot: 'bg-ink-subtle' },
];

/**
 * The agent's own availability.
 *
 * This is what decides whether the widget tells a visitor somebody is here, so it is persisted on
 * the membership rather than inferred from having a browser tab open — an agent with the
 * dashboard on a second monitor at 2am is not available, and pretending otherwise is exactly the
 * kind of fake online status that makes a visitor wait for a reply nobody is going to send.
 */
export function AvailabilityControl({ initial }: { initial: Availability }) {
  const [value, setValue] = useState<Availability>(initial);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => setValue(initial), [initial]);

  async function change(next: Availability) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setFailed(false);
    try {
      await api.put('/team/availability', { availability: next });
    } catch {
      // Roll back rather than leave the control claiming something the server did not accept.
      setValue(previous);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[2];

  return (
    <label className="flex items-center gap-1.5" title={failed ? 'That did not save' : undefined}>
      <span className="sr-only">Your availability</span>
      <span
        className={cn('size-2 rounded-full', current?.dot, saving && 'opacity-50')}
        aria-hidden="true"
      />
      <select
        value={value}
        disabled={saving}
        onChange={(event) => void change(event.target.value as Availability)}
        className={cn(
          'h-8 rounded-[var(--radius-control)] border bg-surface px-2 text-[12px] font-medium text-ink',
          failed ? 'border-danger' : 'border-border-strong',
        )}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
