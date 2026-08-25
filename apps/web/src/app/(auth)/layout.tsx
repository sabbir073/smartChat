import type { ReactNode } from 'react';
import { BrandMark } from '@/components/layout/brand-mark';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-6 py-6 sm:px-10">
        <BrandMark />
      </header>

      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 sm:items-center">
        <div className="w-full max-w-[420px]">{children}</div>
      </main>

      <footer className="px-6 pb-8 text-center text-[13px] text-ink-subtle sm:px-10">
        Self-hosted live chat for your websites.
      </footer>
    </div>
  );
}
