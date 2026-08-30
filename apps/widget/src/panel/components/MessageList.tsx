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
  resolveAttachmentUrl,
}: {
  messages: PanelMessage[];
  welcome: string;
  agentTyping: boolean;
  resolveAttachmentUrl: (attachmentId: string) => Promise<string>;
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
        return (
          <div
            key={message.clientMessageId ?? message.id}
            className="message-row"
            data-mine={fromVisitor}
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
              <span>{timeOf(message.createdAt)}</span>
              {fromVisitor && message.delivery === 'pending' && (
                <span aria-label="Sending">Sending…</span>
              )}
              {fromVisitor && message.delivery === 'failed' && (
                <span className="failed" role="alert">
                  Not sent
                </span>
              )}
            </div>
          </div>
        );
      })}

      {agentTyping && (
        <div className="bubble bubble-agent typing" aria-label="Agent is typing">
          <span />
          <span />
          <span />
        </div>
      )}

      <div ref={bottom} />
    </div>
  );
}
