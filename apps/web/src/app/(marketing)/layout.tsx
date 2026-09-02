import type { ReactNode } from 'react';
import { MarketingFooter, MarketingHeader } from '@/components/marketing/chrome';

/**
 * The public site.
 *
 * A route group rather than a path segment, so these pages live at `/`, `/pricing` and so on while
 * the signed-in application sits under `/app`. The dashboard used to own `/`; moving it was the
 * one structural change this needed, and it is why `middleware.ts` now protects a prefix instead
 * of maintaining a list of public pages.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MarketingHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
