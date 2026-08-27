/**
 * What the visitor sees after leaving a message.
 *
 * It says what happens next in the visitor's own terms - somebody will reply by email - rather
 * than "submitted successfully", which tells them nothing they wanted to know. The chat is still
 * reachable from here, because an agent may well come online in the meantime.
 */
export function OfflineSent({
  email,
  canChat,
  onStartChat,
}: {
  email: string | null;
  canChat: boolean;
  onStartChat: () => void;
}) {
  return (
    <div className="ended" role="status">
      <p className="ended-title">Thanks - we have your message</p>
      <p className="ended-text">
        {email
          ? `We will reply to ${email} as soon as we can.`
          : 'We will get back to you as soon as we can.'}
      </p>
      {canChat && (
        <button type="button" className="ended-action" onClick={onStartChat}>
          Someone is available now - start a chat
        </button>
      )}
    </div>
  );
}

/**
 * The banner above the offline form when somebody comes online while it is being filled in.
 *
 * Offered, never forced: half-typed text is not thrown away because an agent's status changed
 * behind the scenes.
 */
export function AgentArrivedBanner({ onStartChat }: { onStartChat: () => void }) {
  return (
    <div className="banner" role="status">
      Someone just became available.{' '}
      <button type="button" className="banner-action" onClick={onStartChat}>
        Chat now instead
      </button>
    </div>
  );
}
