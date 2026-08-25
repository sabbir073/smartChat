import { io, type Socket } from 'socket.io-client';
import { ServerEvent, VisitorClientEvent } from '@smartchat/types';
import type { MessageDto } from './types.js';
import { API_URL } from './runtime.js';

/**
 * The widget's realtime client.
 *
 * Socket.IO's own reconnection is deliberately switched off. Our connection tickets are
 * single-use, so an automatic retry would replay a ticket that has already been redeemed and fail
 * every time. Reconnecting ourselves means each attempt fetches a fresh ticket - and it lets the
 * backoff be exactly what docs/REALTIME.md specifies.
 */

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface ChatClientHandlers {
  onState(state: ConnectionState): void;
  onMessage(message: MessageDto): void;
  onTyping(payload: { actorType: string; actorName?: string | null; typing: boolean }): void;
  onConversation(payload: { conversationId: string; status?: string }): void;
}

interface Ack<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 1.6;
const BACKOFF_MAX_MS = 30_000;

export class ChatClient {
  private socket: Socket | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private retryTimer: number | null = null;
  private closed = false;

  conversationId: string | null = null;
  lastSeq = 0;

  constructor(
    private readonly visitorToken: string,
    private readonly handlers: ChatClientHandlers,
  ) {}

  get connected(): boolean {
    return this.socket?.connected === true;
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ticket: { ticket: string; url: string };
    try {
      ticket = await this.fetchTicket();
    } catch {
      this.scheduleRetry();
      return;
    }

    const socket = io(`${ticket.url}/visitor`, {
      transports: ['websocket', 'polling'],
      auth: { ticket: ticket.ticket },
      reconnection: false,
      withCredentials: false,
      timeout: 12_000,
    });

    this.socket = socket;

    socket.on('connect', () => {
      this.attempt = 0;
      this.setState('connected');
      // Catch up on anything missed while disconnected, before the visitor notices a gap.
      void this.resync();
    });

    socket.on('connect_error', () => {
      socket.close();
      this.scheduleRetry();
    });

    socket.on('disconnect', (reason) => {
      // A deliberate close from our side is not a failure to recover from.
      if (this.closed || reason === 'io client disconnect') return;
      this.scheduleRetry();
    });

    socket.on(ServerEvent.MESSAGE_NEW, (payload: { message: MessageDto }) => {
      if (!payload?.message) return;
      this.lastSeq = Math.max(this.lastSeq, payload.message.seq);
      this.handlers.onMessage(payload.message);
    });

    socket.on(
      ServerEvent.TYPING,
      (payload: { actorType: string; actorName?: string; typing: boolean }) => {
        // The visitor does not need to be told they are typing.
        if (payload?.actorType === 'visitor') return;
        this.handlers.onTyping(payload);
      },
    );

    socket.on(
      ServerEvent.CONVERSATION_UPDATED,
      (payload: { conversationId: string; status?: string }) =>
        this.handlers.onConversation(payload),
    );
    socket.on(ServerEvent.CONVERSATION_CLOSED, (payload: { conversationId: string }) =>
      this.handlers.onConversation({ ...payload, status: 'closed' }),
    );
  }

  private async fetchTicket(): Promise<{ ticket: string; url: string }> {
    const response = await fetch(`${API_URL}/api/v1/widget/realtime-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.visitorToken}` },
      credentials: 'omit',
      mode: 'cors',
    });
    if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
    const body = (await response.json()) as { data: { ticket: string; url: string } };
    return body.data;
  }

  /** Exponential backoff with jitter, so a gateway restart does not bring every client back at once. */
  private scheduleRetry(): void {
    if (this.closed) return;
    this.setState('reconnecting');
    this.attempt += 1;

    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** (this.attempt - 1));
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(base + jitter));

    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }

  private emit<T>(event: string, payload: unknown, timeoutMs = 12_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('not connected'));
        return;
      }
      socket
        .timeout(timeoutMs)
        .emit(event, payload, (transportError: Error | null, ack: Ack<T>) => {
          if (transportError) {
            reject(transportError);
            return;
          }
          if (!ack?.success) {
            reject(new Error(ack?.error?.message ?? 'The message could not be sent'));
            return;
          }
          resolve(ack.data as T);
        });
    });
  }

  /**
   * Resume the visitor's conversation, then replay anything missed.
   *
   * Replay is by sequence number, not by timestamp: it is exact, and it cannot skip or repeat a
   * message the way a clock-based cursor can.
   */
  private async resync(): Promise<void> {
    try {
      if (!this.conversationId) {
        const resumed = await this.emit<{
          conversation: { id: string; status: string; lastSeq: number } | null;
          messages: MessageDto[];
        }>('conversation:resume', {});

        if (resumed.conversation) {
          this.conversationId = resumed.conversation.id;
          this.lastSeq = resumed.conversation.lastSeq;
          for (const message of resumed.messages) this.handlers.onMessage(message);
          this.handlers.onConversation({
            conversationId: resumed.conversation.id,
            status: resumed.conversation.status,
          });
        }
        return;
      }

      const synced = await this.emit<{ messages: MessageDto[] }>(VisitorClientEvent.SYNC_SINCE, {
        conversationId: this.conversationId,
        lastSeq: this.lastSeq,
      });
      for (const message of synced.messages) {
        this.lastSeq = Math.max(this.lastSeq, message.seq);
        this.handlers.onMessage(message);
      }
    } catch {
      /* the next reconnect will try again */
    }
  }

  async start(
    clientMessageId: string,
    body: string,
    preChat?: Record<string, string>,
  ): Promise<MessageDto> {
    const result = await this.emit<{ conversationId: string; message: MessageDto }>(
      VisitorClientEvent.CONVERSATION_START,
      { clientMessageId, body, ...(preChat ? { preChat } : {}) },
    );
    this.conversationId = result.conversationId;
    this.lastSeq = Math.max(this.lastSeq, result.message.seq);
    return result.message;
  }

  async send(clientMessageId: string, body: string): Promise<MessageDto> {
    if (!this.conversationId) throw new Error('no conversation');
    const result = await this.emit<{ message: MessageDto }>(VisitorClientEvent.MESSAGE_SEND, {
      conversationId: this.conversationId,
      clientMessageId,
      body,
      type: 'text',
    });
    this.lastSeq = Math.max(this.lastSeq, result.message.seq);
    return result.message;
  }

  typing(isTyping: boolean): void {
    if (!this.socket?.connected || !this.conversationId) return;
    this.socket.emit(isTyping ? VisitorClientEvent.TYPING_START : VisitorClientEvent.TYPING_STOP, {
      conversationId: this.conversationId,
    });
  }

  /**
   * End the chat.
   *
   * Resolves only once the server has committed the change, so the panel never shows "ended" for
   * a chat that is still open on the agent's screen.
   */
  async endChat(): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected || !this.conversationId) throw new Error('not connected');
    const conversationId = this.conversationId;

    await new Promise<void>((resolve, reject) => {
      socket
        .timeout(10_000)
        .emit(
          VisitorClientEvent.CONVERSATION_CLOSE,
          { conversationId },
          (
            transportError: Error | null,
            ack: { success: boolean; error?: { message: string } },
          ) => {
            if (transportError) return reject(transportError);
            if (!ack?.success)
              return reject(new Error(ack?.error?.message ?? 'Could not end the chat'));
            return resolve();
          },
        );
    });
  }

  /** Forget the conversation so the next message starts a new one rather than resuming this. */
  forgetConversation(): void {
    this.conversationId = null;
  }

  markRead(): void {
    if (!this.socket?.connected || !this.conversationId) return;
    this.socket.emit(VisitorClientEvent.MESSAGE_READ, { conversationId: this.conversationId });
  }

  reportPage(url: string, title: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit(VisitorClientEvent.PAGE_VIEW, { url, title });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
    this.setState('idle');
  }
}
