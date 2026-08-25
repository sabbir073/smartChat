export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
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
    </span>
  );
}
