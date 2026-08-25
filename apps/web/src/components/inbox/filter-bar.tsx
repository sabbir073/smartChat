'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import type { PropertyDto } from '@/lib/types';

export type StatusFilter = 'open' | 'pending' | 'closed' | 'all';
export type AssignedFilter = 'any' | 'me' | 'unassigned';

export interface InboxFilters {
  status: StatusFilter;
  assigned: AssignedFilter;
  propertyId: string | 'all';
  search: string;
  tags: string[];
}

export const DEFAULT_FILTERS: InboxFilters = {
  status: 'open',
  assigned: 'any',
  propertyId: 'all',
  search: '',
  tags: [],
};

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const ASSIGNED: { value: AssignedFilter; label: string }[] = [
  { value: 'any', label: 'Everyone' },
  { value: 'me', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
];

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
        active ? 'bg-ink text-ink-inverted' : 'text-ink-muted hover:bg-surface-raised',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The inbox filter bar.
 *
 * The search box is debounced locally rather than on every keystroke: a substring search across
 * message bodies is an index scan, not free, and an agent typing a visitor's name should not fire
 * eight of them. The committed value is what the parent queries with.
 */
export function FilterBar({
  filters,
  properties,
  knownTags,
  resultCount,
  onChange,
}: {
  filters: InboxFilters;
  properties: PropertyDto[];
  knownTags: string[];
  resultCount: number | null;
  onChange: (next: InboxFilters) => void;
}) {
  const [draftSearch, setDraftSearch] = useState(filters.search);
  const debounce = useRef<number | null>(null);
  const committed = useRef(filters.search);

  // Keep the box in step when the parent resets the filters (the "clear" button below).
  useEffect(() => {
    if (filters.search !== committed.current) {
      committed.current = filters.search;
      setDraftSearch(filters.search);
    }
  }, [filters.search]);

  useEffect(
    () => () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    },
    [],
  );

  function onSearchChange(value: string) {
    setDraftSearch(value);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      committed.current = value.trim();
      onChange({ ...filters, search: value.trim() });
    }, 350);
  }

  function commitSearchNow() {
    if (debounce.current) window.clearTimeout(debounce.current);
    committed.current = draftSearch.trim();
    onChange({ ...filters, search: draftSearch.trim() });
  }

  const filtered =
    filters.status !== DEFAULT_FILTERS.status ||
    filters.assigned !== 'any' ||
    filters.propertyId !== 'all' ||
    filters.search !== '' ||
    filters.tags.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
          {STATUSES.map((entry) => (
            <Pill
              key={entry.value}
              active={filters.status === entry.value}
              onClick={() => onChange({ ...filters, status: entry.value })}
            >
              {entry.label}
            </Pill>
          ))}
        </div>

        <span className="h-5 w-px bg-border" aria-hidden="true" />

        <label className="sr-only" htmlFor="inbox-assigned">
          Filter by assignment
        </label>
        <select
          id="inbox-assigned"
          value={filters.assigned}
          onChange={(event) =>
            onChange({ ...filters, assigned: event.target.value as AssignedFilter })
          }
          className="h-8 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] text-ink"
        >
          {ASSIGNED.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>

        {properties.length > 1 && (
          <>
            <label className="sr-only" htmlFor="inbox-property">
              Filter by website
            </label>
            <select
              id="inbox-property"
              value={filters.propertyId}
              onChange={(event) => onChange({ ...filters, propertyId: event.target.value })}
              className="h-8 max-w-[180px] rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] text-ink"
            >
              <option value="all">All websites</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="inbox-search">
            Search conversations
          </label>
          <input
            id="inbox-search"
            type="search"
            value={draftSearch}
            placeholder="Search names, emails and messages"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitSearchNow();
              }
            }}
            className="h-8 w-56 rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[13px] text-ink placeholder:text-ink-subtle"
          />
          {filtered && (
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_FILTERS })}
              className="text-[12px] text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {knownTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-subtle">Tags</span>
          {knownTags.map((tag) => {
            const active = filters.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    ...filters,
                    tags: active
                      ? filters.tags.filter((entry) => entry !== tag)
                      : [...filters.tags, tag],
                  })
                }
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'border-brand/30 bg-brand-soft text-brand'
                    : 'border-border text-ink-muted hover:bg-surface-raised',
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {filtered && resultCount !== null && (
        <p className="text-[12px] text-ink-subtle" role="status">
          {resultCount === 0
            ? 'No conversations match these filters.'
            : `${resultCount} conversation${resultCount === 1 ? ' matches' : 's match'} these filters.`}
        </p>
      )}
    </div>
  );
}
