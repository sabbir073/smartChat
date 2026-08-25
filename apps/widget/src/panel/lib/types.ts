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
}

/**
 * A message as the panel holds it.
 *
 * `pending` and `failed` exist only on the client: the server has no such states, because a
 * message it knows about is by definition already durable.
 */
export interface PanelMessage extends MessageDto {
  delivery: 'pending' | 'sent' | 'failed';
}
