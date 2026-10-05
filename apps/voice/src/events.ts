import type { MessageDto, RedisClient } from '@smartchat/core';
import { RedisChannel, ServerEvent, type CallDto } from '@smartchat/types';

/**
 * What the rest of the system tells a call session while it runs.
 *
 * The call service publishes every change to a call, and the gateway publishes every message
 * in a conversation, on one Redis channel. A session needs two things from it: the moment its
 * call comes back from a failed hand-over (status active, still the AI's), and the email a
 * visitor types in the chat box while the AI waits for it. One subscription for the process,
 * routed to sessions by call and by conversation; nothing else on the channel is looked at.
 */

export interface CallEventBusOptions {
  subscriber: RedisClient;
  log: (event: string, detail: Record<string, unknown>) => void;
}

type CallListener = (call: CallDto) => void;
type MessageListener = (message: MessageDto) => void;

export class CallEventBus {
  private readonly byCall = new Map<string, Set<CallListener>>();
  private readonly byConversation = new Map<string, Set<MessageListener>>();
  private started = false;

  constructor(private readonly options: CallEventBusOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.options.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== RedisChannel.CONVERSATION_EVENTS) return;
      this.route(raw);
    });
    await this.options.subscriber.subscribe(RedisChannel.CONVERSATION_EVENTS);
  }

  onCall(callId: string, listener: CallListener): () => void {
    return add(this.byCall, callId, listener);
  }

  onConversationMessage(conversationId: string, listener: MessageListener): () => void {
    return add(this.byConversation, conversationId, listener);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.subscriber
      .unsubscribe(RedisChannel.CONVERSATION_EVENTS)
      .catch(() => undefined);
    this.byCall.clear();
    this.byConversation.clear();
  }

  private route(raw: string): void {
    let event: { type?: unknown; payload?: unknown };
    try {
      event = JSON.parse(raw) as { type?: unknown; payload?: unknown };
    } catch {
      this.options.log('voice.events.malformed', {});
      return;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === ServerEvent.CALL_UPDATED) {
      const call = payload['call'] as CallDto | undefined;
      if (!call || typeof call.id !== 'string') return;
      for (const listener of this.byCall.get(call.id) ?? []) this.safely(() => listener(call));
      return;
    }
    if (event.type === ServerEvent.MESSAGE_NEW) {
      const message = payload['message'] as MessageDto | undefined;
      if (!message || typeof message.conversationId !== 'string') return;
      for (const listener of this.byConversation.get(message.conversationId) ?? []) {
        this.safely(() => listener(message));
      }
    }
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.log('voice.events.listener_failed', { error: String(error) });
    }
  }
}

function add<T>(index: Map<string, Set<T>>, key: string, listener: T): () => void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = index.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) index.delete(key);
  };
}
