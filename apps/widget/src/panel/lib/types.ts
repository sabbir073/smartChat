/**
 * Structured detail on a system message, so the panel writes its own wording.
 *
 * Mirrors the server's definition in `packages/core/src/realtime/events.ts`; the two are kept in
 * step by hand because the panel must not depend on the core package.
 */
export interface SystemMessageEvent {
  kind:
    | 'conversation.closed'
    | 'conversation.reopened'
    | 'call.started'
    | 'call.answered'
    | 'call.transferred'
    | 'call.missed'
    | 'call.ended';
  /** `ai` is the assistant; `system` is a timer or the server itself. */
  by: 'visitor' | 'agent' | 'ai' | 'system';
  actorName?: string;
  /** For call events: which call, how long it lasted, who it went to. */
  callId?: string;
  durationSeconds?: number;
  targetName?: string;
}

/** What the panel needs to render a file. Never a URL: those are minted per request. */
export interface MessageAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  clientMessageId: string | null;
  senderType: 'visitor' | 'agent' | 'system' | 'bot';
  senderId: string | null;
  senderName: string | null;
  type: 'text' | 'file' | 'image' | 'system' | 'note';
  body: string;
  createdAt: string;
  readAt: string | null;
  /** Present on `type: 'file'` and `type: 'image'`. */
  attachment?: MessageAttachment;
  /** Present only on `type: 'system'`. */
  event?: SystemMessageEvent;
  /** Present on bot messages the AI assistant wrote. */
  ai?: AiMessageInfo;
  /** Present when the message is something that was said on a call, transcribed. */
  voice?: { callId: string };
}

/** Where an AI reply came from, and whether it carries the ticket offer. */
export interface AiMessageInfo {
  sources: Array<{ title: string; url: string | null }>;
  offer?: 'ticket';
  /** The visitor's own thumbs up or down, when given. */
  rating?: 'up' | 'down';
  /** The owner chose to mark the assistant's replies. Off by default. */
  badge?: boolean;
  kind?: string;
}

/**
 * A message as the panel holds it.
 *
 * `pending` and `failed` exist only on the client: the server has no such states, because a
 * message it knows about is by definition already durable.
 */
export interface PanelMessage extends MessageDto {
  delivery: 'pending' | 'sent' | 'failed';
  /** While a file is on its way up, so the bubble can show progress rather than nothing. */
  uploading?: { fileName: string; byteSize: number };
}
