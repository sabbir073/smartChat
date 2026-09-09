import { useEffect, useRef } from 'react';
import type { PanelMessage } from '../lib/types.js';
import { AttachmentBubble, UploadingBubble } from './Attachment.js';

/**
 * The visitor-facing wording for a system message.
 *
 * Written here rather than read from `body` so the panel controls its own voice: the visitor is
 * "you", and an agent is named or called by the business's own label. `body` is the server's
 * English fallback and is used only if a future event kind reaches an older panel.
 */
function systemText(message: PanelMessage): string {
  const event = message.event;
  if (!event) return message.body;

  const actor = event.by === 'visitor' ? 'You' : (event.actorName ?? 'The support team');
  return event.kind === 'conversation.closed'
    ? `${actor} ended this chat`
    : `${actor} reopened this chat`;
}

function timeOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageList({
  messages,
  welcome,
  agentTyping,
  typingName,
  resolveAttachmentUrl,
  offer,
  onRate,
}: {
  messages: PanelMessage[];
  welcome: string;
  agentTyping: boolean;
  /** Who the typing indicator is for; the AI assistant names itself. */
  typingName?: string | null;
  resolveAttachmentUrl: (attachmentId: string) => Promise<string>;
  /**
   * The ticket offer's buttons. Shown under the newest message when it carries the offer and the
   * visitor has not answered it yet; absent in previews and once a ticket form is open.
   */
  offer?: { onCreateTicket: () => void; onDismiss: () => void; dismissed: boolean } | undefined;
  /** Thumbs up or down on an AI answer. Absent in previews. */
  onRate?: ((messageId: string, rating: 'up' | 'down' | null) => void) | undefined;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  /**
   * Follow new messages, but only when the visitor is already at the bottom.
   *
   * Yanking somebody back down while they are reading earlier messages is one of the most
   * irritating things a chat widget can do.
   */
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 80;
  }, [messages.length]);

  useEffect(() => {
    if (stickToBottom.current) {
      bottom.current?.scrollIntoView({ behavior: messages.length > 1 ? 'smooth' : 'auto' });
    }
  }, [messages, agentTyping]);

  return (
    <div className="body" ref={container} role="log" aria-live="polite" aria-label="Conversation">
      {welcome && <div className="bubble bubble-agent">{welcome}</div>}

      {messages.map((message) => {
        if (message.type === 'system') {
          return (
            <div className="system-row" key={message.id} role="status">
              <span className="system-line" aria-hidden="true" />
              <span className="system-text">
                {systemText(message)} · {timeOf(message.createdAt)}
              </span>
              <span className="system-line" aria-hidden="true" />
            </div>
          );
        }

        const fromVisitor = message.senderType === 'visitor';
        const fromAi = message.senderType === 'bot' && message.ai !== undefined;
        const sources = fromAi ? (message.ai?.sources ?? []).filter((s) => s.url) : [];
        const isLast = message === messages[messages.length - 1];
        const showOffer =
          fromAi && message.ai?.offer === 'ticket' && isLast && offer !== undefined && !offer.dismissed;
        // Only what the assistant said in its own words is rated; the offer is the owner's sentence.
        const canRate = fromAi && !message.ai?.offer && onRate !== undefined && message.delivery !== 'pending';
        const rating = message.ai?.rating;
        return (
          <div
            key={message.clientMessageId ?? message.id}
            className="message-row"
            data-mine={fromVisitor}
            data-sender={message.senderType}
          >
            {/* Rendered as a text node, never as markup: message bodies are stored exactly as
                received and are never trusted as HTML. */}
            <div
              className={`bubble ${fromVisitor ? 'bubble-visitor' : 'bubble-agent'}`}
              data-delivery={message.delivery}
              data-file={message.type === 'file' || message.type === 'image' || undefined}
            >
              {message.uploading ? (
                <UploadingBubble
                  fileName={message.uploading.fileName}
                  byteSize={message.uploading.byteSize}
                />
              ) : message.attachment ? (
                <AttachmentBubble
                  attachment={message.attachment}
                  resolveUrl={resolveAttachmentUrl}
                />
              ) : (
                message.body
              )}
            </div>
            <div className="message-meta">
              {!fromVisitor && message.senderName && <span>{message.senderName}</span>}
              {fromAi && (
                <span className="ai-badge" title="Written by an AI assistant">
                  AI
                </span>
              )}
              <span>{timeOf(message.createdAt)}</span>
              {fromVisitor && message.delivery === 'pending' && (
                <span aria-label="Sending">Sending…</span>
              )}
              {fromVisitor && message.delivery === 'failed' && (
                <span className="failed" role="alert">
                  Not sent
                </span>
              )}
              {canRate && (
                <span className="ai-rate" role="group" aria-label="Was this helpful?">
                  <button
                    type="button"
                    className="ai-rate-button"
                    aria-pressed={rating === 'up'}
                    aria-label="Helpful"
                    title="Helpful"
                    onClick={() => onRate(message.id, rating === 'up' ? null : 'up')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M7 10v12" />
                      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ai-rate-button"
                    aria-pressed={rating === 'down'}
                    aria-label="Not helpful"
                    title="Not helpful"
                    onClick={() => onRate(message.id, rating === 'down' ? null : 'down')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M17 14V2" />
                      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            {sources.length > 0 && (
              <div className="ai-sources">
                From:{' '}
                {sources.map((source, i) => (
                  <span key={source.url ?? i}>
                    {i > 0 && ', '}
                    <a href={source.url ?? '#'} target="_blank" rel="noopener noreferrer">
                      {source.title}
                    </a>
                  </span>
                ))}
              </div>
            )}
            {showOffer && (
              <div className="ai-offer" role="group" aria-label="Open a support ticket?">
                <button type="button" className="ai-offer-button primary" onClick={offer.onCreateTicket}>
                  Create a ticket
                </button>
                <button type="button" className="ai-offer-button" onClick={offer.onDismiss}>
                  Ask something else
                </button>
              </div>
            )}
          </div>
        );
      })}

      {agentTyping && (
        <div className="bubble bubble-agent typing" aria-label={`${typingName ?? 'Agent'} is typing`}>
          <span />
          <span />
          <span />
        </div>
      )}

      <div ref={bottom} />
    </div>
  );
}
