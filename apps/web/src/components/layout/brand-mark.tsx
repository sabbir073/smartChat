import Link from 'next/link';

/**
 * The wordmark, and a way back.
 *
 * It is a link by default rather than by decision at each call site, because the version that is
 * not a link is the one people click anyway. It sat inert on the sign-in and error pages — the
 * two places somebody is most likely to want out — while the marketing header's wordmark, a
 * different component, had been a link all along.
 *
 * `href` says where back is: the marketing home from the public pages, the dashboard from inside
 * the application, where a link to the marketing site would be a way *out* rather than a way home.
 */
export function BrandMark({
  size = 28,
  href = '/',
  label = 'SmartChat home',
}: {
  size?: number;
  href?: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex items-center gap-2 rounded-[var(--radius-control)] outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="9" fill="var(--color-brand)" />
        <path
          d="M9 13.5A4.5 4.5 0 0 1 13.5 9h5A4.5 4.5 0 0 1 23 13.5v3A4.5 4.5 0 0 1 18.5 21H14l-4 3.2V21A4.5 4.5 0 0 1 9 16.5v-3Z"
          fill="white"
          fillOpacity="0.95"
        />
        <circle cx="13.5" cy="15" r="1.2" fill="var(--color-brand)" />
        <circle cx="17" cy="15" r="1.2" fill="var(--color-brand)" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-ink">SmartChat</span>
    </Link>
  );
}
