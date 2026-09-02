import type { ReactNode } from 'react';
import { Eyebrow } from './sections';

/**
 * The top of an inner page.
 *
 * A separate component from the home page's hero, which is a two-column layout with a live
 * illustration and does not generalise. This one exists so every inner page opens the same way -
 * on the canvas tone, which is what the header sits transparently over until it is scrolled.
 */
export function PageHero({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead: string;
  children?: ReactNode;
}) {
  return (
    <section className="mk-aurora mk-grid relative border-b border-border bg-canvas">
      <div className="relative mx-auto max-w-4xl px-5 pb-20 pt-[calc(5rem+72px)] text-center sm:pb-24 sm:pt-[calc(6rem+72px)]">
        <div className="flex justify-center">
          <Eyebrow>{eyebrow}</Eyebrow>
        </div>
        <h1 className="mt-4 text-balance text-[36px] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[52px]">
          {title}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-muted">{lead}</p>
        {children && <div className="mt-9 flex flex-wrap justify-center gap-3">{children}</div>}
      </div>
    </section>
  );
}
