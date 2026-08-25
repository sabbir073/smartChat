export function PanelHeader({
  title,
  subtitle,
  online,
  avatarUrl,
  canEnd,
  onEnd,
  onMinimise,
}: {
  title: string;
  subtitle: string;
  online: boolean;
  avatarUrl: string | null;
  /** Only offered while there is a live chat to end. */
  canEnd: boolean;
  onEnd: () => void;
  onMinimise: () => void;
}) {
  const initials = title
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <header className="header">
      <div className="header-avatar" aria-hidden="true">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : initials}
      </div>

      <div className="header-text">
        <h1 className="header-title">{title}</h1>
        <p className="header-subtitle">
          <span className="status-dot" data-online={online} aria-hidden="true" />
          {subtitle}
        </p>
      </div>

      {canEnd && (
        <button type="button" className="header-end" onClick={onEnd}>
          End chat
        </button>
      )}

      {/* Minimise, not end. The two were the same button before there was anything to end, and
          labelling this one "Close" made it look like it threw the conversation away. */}
      <button
        type="button"
        className="header-close"
        onClick={onMinimise}
        aria-label="Minimise chat"
        title="Minimise"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}
