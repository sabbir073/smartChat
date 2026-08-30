import type { ReactNode } from 'react';

/**
 * The public help centre's frame.
 *
 * Deliberately separate from the dashboard shell: there is no sidebar, no account switcher and no
 * session here, because there is no reader to have one. Anything that assumed a signed-in person
 * would be a bug waiting to be found by a stranger.
 */
export default function HelpLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-canvas">{children}</div>;
}
