'use client';

import { io, type Socket } from 'socket.io-client';
import { AgentClientEvent, ServerEvent } from '@smartchat/types';
import { api } from './api-client';

/**
 * The dashboard's realtime client.
 *
 * Socket.IO's own reconnection is switched off on purpose: connection tickets are single-use, so
 * an automatic retry would replay a redeemed ticket and fail every time. Reconnecting ourselves
 * means every attempt fetches a fresh ticket, and the backoff is the one documented in
 * docs/REALTIME.md rather than the library's default.
 */

export type AgentConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface AgentMessage {
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

/** One property's live visitors, as the gateway knows them at the moment of subscribing. */
export interface VisitorPresenceSnapshot {
  propertyId: string;
  visitors: { visitorId: string; url: string | null; title: string | null; updatedAt: number }[];
}

export interface AgentClientHandlers {
  onState(state: AgentConnectionState): void;
  /**
   * The presence snapshot returned when the inbox subscribes.
   *
   * Without this the dashboard would only learn a visitor is online when they *change* something,
   * so every visitor who connected before the agent opened the inbox would be shown as offline -
   * which is worse than showing nothing, because it is confidently wrong.
   */
  onPresenceSnapshot(snapshot: VisitorPresenceSnapshot[]): void;
  onMessage(message: AgentMessage): void;
  onTyping(payload: { conversationId: string; actorType: string; typing: boolean }): void;
  onConversationEvent(type: string, payload: Record<string, unknown>): void;
  onVisitorPresence(payload: { visitorId: string; online: boolean; url?: string | null }): void;
}

interface Ack<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 1.6;
const BACKOFF_MAX_MS = 30_000;

export class AgentRealtimeClient {
  private socket: Socket | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private closed = false;
  private state: AgentConnectionState = 'idle';
  private subscribedProperties: string[] = [];
  private openConversationId: string | null = null;

  constructor(private readonly handlers: AgentClientHandlers) {}

  get connected(): boolean {
    return this.socket?.connected === true;
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ticket: { ticket: string; url: string };
    try {
      const { data } = await api.post<{ ticket: string; url: string }>('/realtime/ticket');
      ticket = data;
    } catch {
      this.scheduleRetry();
      return;
    }

    const socket = io(`${ticket.url}/agent`, {
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
      // Re-establish everything this client was watching before it dropped.
      if (this.subscribedProperties.length > 0) {
        // A resubscribe that fails leaves this client watching nothing, so it drops the socket and
        // lets the normal backoff try again rather than sitting silently connected and deaf.
        void this.subscribe(this.subscribedProperties).catch(() => socket.close());
      }
      if (this.openConversationId) void this.openConversation(this.openConversationId);
    });

    socket.on('connect_error', () => {
      socket.close();
      this.scheduleRetry();
    });

    socket.on('disconnect', (reason) => {
      if (this.closed || reason === 'io client disconnect') return;
      this.scheduleRetry();
    });

    socket.on(ServerEvent.MESSAGE_NEW, (payload: { message: AgentMessage }) => {
      if (payload?.message) this.handlers.onMessage(payload.message);
    });
    socket.on(
      ServerEvent.TYPING,
      (payload: { conversationId: string; actorType: string; typing: boolean }) =>
        this.handlers.onTyping(payload),
    );
    socket.on(ServerEvent.PRESENCE_VISITOR, (payload: { visitorId: string; online: boolean }) =>
      this.handlers.onVisitorPresence(payload),
    );

    for (const event of [
      ServerEvent.CONVERSATION_CREATED,
      ServerEvent.CONVERSATION_UPDATED,
      ServerEvent.CONVERSATION_ASSIGNED,
      ServerEvent.CONVERSATION_CLOSED,
    ]) {
      socket.on(event, (payload: Record<string, unknown>) =>
        this.handlers.onConversationEvent(event, payload),
      );
    }
  }

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

  private setState(state: AgentConnectionState): void {
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
          if (transportError) return reject(transportError);
          if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'Request failed'));
          return resolve(ack.data as T);
        });
    });
  }

  async subscribe(propertyIds: string[]): Promise<void> {
    this.subscribedProperties = propertyIds;
    if (!this.connected) return;

    const result = await this.emit<{
      subscribed: string[];
      presence: VisitorPresenceSnapshot[];
    }>(AgentClientEvent.INBOX_SUBSCRIBE, { propertyIds });

    this.handlers.onPresenceSnapshot(result.presence ?? []);
  }

  async openConversation(conversationId: string): Promise<AgentMessage[]> {
    this.openConversationId = conversationId;
    const result = await this.emit<{ messages: AgentMessage[] }>(
      AgentClientEvent.CONVERSATION_OPEN,
      { conversationId, limit: 50 },
    );
    return result.messages;
  }

  closeConversation(conversationId: string): void {
    if (this.openConversationId === conversationId) this.openConversationId = null;
    this.socket?.emit(AgentClientEvent.CONVERSATION_CLOSE_VIEW, { conversationId });
  }

  async send(conversationId: string, clientMessageId: string, body: string, asNote: boolean) {
    return this.emit<{ message: AgentMessage }>(
      asNote ? AgentClientEvent.NOTE_ADD : AgentClientEvent.MESSAGE_SEND,
      { conversationId, clientMessageId, body, type: asNote ? 'note' : 'text' },
    );
  }

  typing(conversationId: string, isTyping: boolean): void {
    if (!this.connected) return;
    this.socket?.emit(isTyping ? AgentClientEvent.TYPING_START : AgentClientEvent.TYPING_STOP, {
      conversationId,
    });
  }

  markRead(conversationId: string, seq: number): void {
    if (!this.connected) return;
    this.socket?.emit(AgentClientEvent.MESSAGE_READ, { conversationId, seq });
  }

  setAvailability(status: 'online' | 'away' | 'offline'): void {
    this.socket?.emit(AgentClientEvent.PRESENCE_SET, { status });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }
}

/** A ULID, matching what the widget generates. See apps/widget/src/panel/lib/ulid.ts. */
export function ulid(now: number = Date.now()): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  let remaining = now;
  for (let i = 9; i >= 0; i -= 1) {
    time = ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = '';
  for (let i = 0; i < 16; i += 1) random += ALPHABET[(bytes[i] as number) % 32];
  return time + random;
}
