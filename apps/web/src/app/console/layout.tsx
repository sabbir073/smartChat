import type { ReactNode } from 'react';

/**
 * The platform console's frame.
 *
 * Deliberately not the dashboard shell, and deliberately visually distinct: an operator with the
 * power to suspend somebody's business should never be a moment's confusion away from believing
 * they are in an ordinary account. Dark, narrow, and it says which product it is.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-ink text-ink-inverted">{children}</div>;
}
