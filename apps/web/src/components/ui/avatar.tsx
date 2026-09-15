'use client';

import { useEffect, useState } from 'react';
import { cn } from './cn';

/**
 * A person, as a circle.
 *
 * Their picture when there is one and it loads, their initials when there is not - and, just as
 * importantly, their initials again when the picture *fails* to load. A profile picture is served
 * from a different origin to the dashboard, so a content-security policy, an expired object or a
 * network with opinions can all stop it arriving; showing a torn-page icon in a chat header
 * because of that is worse than showing two letters.
 */
export function Avatar({
  name,
  url,
  size = 36,
  className,
  title,
}: {
  /** Whose initials stand in. Empty or unknown names fall back to a dash rather than a blank. */
  name: string | null | undefined;
  url?: string | null;
  /** Pixels. The font scales with it so initials never overflow the circle. */
  size?: number;
  className?: string;
  title?: string;
}) {
  const [broken, setBroken] = useState(false);

  // A new picture deserves a new attempt: without this, one failure would keep the initials
  // showing for the rest of the session even after the owner uploaded a working image.
  useEffect(() => setBroken(false), [url]);

  const showImage = Boolean(url) && !broken;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft font-semibold text-brand',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
      title={title}
    >
      {showImage ? (
        <img
          src={url as string}
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(true)}
          loading="lazy"
          decoding="async"
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export function initialsOf(name: string | null | undefined): string {
  const letters = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
  return letters || '–';
}
