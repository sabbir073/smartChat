'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog that behaves like one: Escape closes it, focus moves inside on open and returns to the
 * trigger on close, and background scrolling is locked while it is open.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /**
   * The close callback, held in a ref rather than read as a dependency.
   *
   * Every caller passes an inline arrow - `onClose={() => setDraft(null)}` - which is a new
   * function on every render. If the effect below depended on it, then every keystroke inside the
   * dialog would re-render the parent, change the identity of `onClose`, tear the effect down and
   * set it up again - and its setup moves focus to the first field. The symptom is that a person
   * types two characters into the third field of a dialog and the rest of the sentence lands in
   * the first one. Found in a browser; no server-side test could have seen it.
   *
   * The alternative - telling every caller to wrap its handler in `useCallback` - puts a
   * correctness requirement on the callers and is one forgotten wrapper away from coming back.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      // Trap Tab inside the dialog, so focus cannot wander behind the overlay.
      const items = panelRef.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href]',
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-ink/25 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative mt-8 w-full max-w-lg rounded-[var(--radius-card)] border border-border bg-surface shadow-2xl"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-muted">{description}</p>}
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-raised px-5 py-3 rounded-b-[var(--radius-card)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
