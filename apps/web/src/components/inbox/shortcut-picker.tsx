'use client';

import { cn } from '@/components/ui';
import type { ShortcutDto } from '@/lib/types';

/**
 * The list that appears when an agent types "/".
 *
 * It sits above the composer rather than replacing it: the agent keeps seeing what they have
 * already written, which matters because a shortcut is usually inserted mid-sentence rather than
 * into an empty box.
 *
 * Selection is driven from the composer, so the arrow keys move this list while the caret stays
 * in the textarea - a picker that stole focus would break the one thing it exists to speed up.
 */
export function ShortcutPicker({
  shortcuts,
  query,
  activeIndex,
  onPick,
}: {
  shortcuts: ShortcutDto[];
  query: string;
  activeIndex: number;
  onPick: (shortcut: ShortcutDto) => void;
}) {
  if (shortcuts.length === 0) {
    return (
      <div className="mb-2 rounded-[var(--radius-control)] border border-border bg-surface p-3 text-[13px] text-ink-muted shadow-sm">
        {query.length > 0 ? (
          <>
            No shortcut matches <span className="font-mono text-ink">/{query}</span>
          </>
        ) : (
          'No shortcuts yet. An administrator can add them under Automation.'
        )}
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="Shortcuts"
      className="mb-2 max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-border bg-surface shadow-sm"
    >
      {shortcuts.map((shortcut, index) => (
        <button
          key={shortcut.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          // Mouse-down rather than click: click fires after blur, and the composer would have
          // already closed the picker by then.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(shortcut);
          }}
          className={cn(
            'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors',
            index === activeIndex ? 'bg-surface-raised' : 'hover:bg-surface-raised',
          )}
        >
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] text-brand">/{shortcut.key}</span>
            <span className="text-[13px] font-medium text-ink">{shortcut.title}</span>
          </span>
          <span className="line-clamp-1 text-[12px] text-ink-muted">{shortcut.body}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Find the "/word" the caret is sitting in, if any.
 *
 * A shortcut token has to start the message or follow whitespace - otherwise every URL an agent
 * pastes would open the picker halfway through "https://".
 */
export function readShortcutQuery(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const slash = before.lastIndexOf('/');
  if (slash === -1) return null;
  if (slash > 0 && !/\s/.test(before.charAt(slash - 1))) return null;

  const query = before.slice(slash + 1);
  if (!/^[a-z0-9_-]*$/i.test(query)) return null;
  return { query: query.toLowerCase(), start: slash };
}
