/** Structured detail on a system message, so the panel writes its own wording. */
export interface SystemMessageEvent {
  kind: 'conversation.closed' | 'conversation.reopened';
  by: 'visitor' | 'agent';
  actorName?: string;
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
