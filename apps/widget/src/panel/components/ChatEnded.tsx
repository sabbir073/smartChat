/**
 * What the visitor sees once a chat has ended.
 *
 * The transcript stays on screen — a person who has just been helped often wants to re-read what
 * they were told, and wiping it the moment the chat closes is the single most annoying thing a
 * widget can do here. The composer is replaced rather than merely disabled, because a disabled
 * text box invites people to type into it and wonder why nothing happens.
 */
export function ChatEnded({
  endedByVisitor,
  busy,
  onStartNew,
}: {
  endedByVisitor: boolean;
  busy: boolean;
  onStartNew: () => void;
}) {
  return (
    <div className="ended" role="status">
      <p className="ended-title">This chat has ended</p>
      <p className="ended-text">
        {endedByVisitor
          ? 'Thanks for getting in touch. Your messages are still here if you need them.'
          : 'The conversation was closed by our team. Your messages are still here if you need them.'}
      </p>
      <button type="button" className="ended-action" onClick={onStartNew} disabled={busy}>
        Start a new chat
      </button>
    </div>
  );
}

/**
 * The confirmation step for ending a chat.
 *
 * Inline rather than a browser dialog: a `confirm()` inside a cross-origin iframe blocks the
 * host page, and this is a small enough decision that a two-button strip is enough friction to
 * stop an accidental tap without being in the way.
 */
export function EndChatConfirm({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm">
      <p className="confirm-text">{error ?? 'End this chat? You can always start a new one.'}</p>
      <div className="confirm-actions">
        <button type="button" className="confirm-cancel" onClick={onCancel} disabled={busy}>
          Keep chatting
        </button>
        <button type="button" className="confirm-end" onClick={onConfirm} disabled={busy}>
          {busy ? 'Ending…' : 'End chat'}
        </button>
      </div>
    </div>
  );
}
