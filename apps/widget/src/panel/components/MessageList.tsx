import { useEffect, useRef } from 'react';
import type { PanelMessage } from '../lib/types.js';

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
}: {
  messages: PanelMessage[];
  welcome: string;
  agentTyping: boolean;
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
            >
              {message.body}
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
