import { API_URL } from './runtime.js';
import type { WidgetConfig } from '@smartchat/validation';
import type { CallDto, CallJoinGrant, VoiceLanguage } from '@smartchat/types';
import type { MessageAttachment, MessageDto } from './types.js';

/**
 * A call as the server hands it back, with the key to its media room.
 *
 * `join` is null only when the call was missed on the spot - nobody to ring and no AI to take
 * it - in which case `call.status` is already `ended`.
 */
export interface CallStartResponse {
  call: CallDto;
  join: CallJoinGrant | null;
}

/** A live call found on load, so a reload mid-call picks it up again. */
export interface CurrentCallResponse {
  call: CallDto;
  join: CallJoinGrant;
}

export interface BootstrapResponse {
  token: string;
  expiresInSeconds: number;
  visitor: { id: string; name: string | null; email: string | null; isReturning: boolean };
  sessionId: string;
  property: { publicId: string; name: string };
  widget: { version: number; config: WidgetConfig };
  /** Whether anyone is available right now, so the first render is honest before the socket connects. */
  agentsAvailable: boolean;
  /** The largest file this deployment accepts. Sent by the server rather than guessed here. */
  maxUploadBytes: number;
  /**
   * Whether to show "Powered by SmartChat".
   *
   * The server decides. Branding removal is something a plan sells, and this widget runs on the
   * customer's own page - a flag it worked out for itself would be one line of JavaScript away
   * from being worked out differently.
   */
  showBranding: boolean;
  /** Who the window shows at the top: the assigned person or the owner. Null when the account has no owner. */
  presenter?: { name: string; avatarUrl: string | null } | null;
  /**
   * Whether the Call button is offered at all.
   *
   * Decided by the server from the plan and the website's settings, for the same reason as
   * branding: a flag the panel worked out for itself would be worked out differently.
   */
  voice: { enabled: boolean };
}

export class WidgetApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WidgetApiError';
  }
}

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // A bearer token, never a cookie: the widget is third-party on every site it runs on, and
  // third-party cookies are both blocked by default and the wrong tool here.
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  /**
   * A failed connection is an error with a sentence, not a raw `TypeError: Failed to fetch`.
   *
   * This runs on somebody else's website, where an ad blocker, an offline laptop or a corporate
   * proxy are all ordinary. Every one of those rejects the promise rather than resolving it, and
   * a caller that only knows about `WidgetApiError` would let the browser's own wording reach a
   * visitor. `status: 0` is the agreed signal for "never got an answer", which is what the panel
   * already branches on to choose its own wording.
   */
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'omit',
      mode: 'cors',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new WidgetApiError('NETWORK_ERROR', 'Could not reach the chat service', 0);
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: { code: string; message: string } }
    | null;

  if (!response.ok || !payload || payload.success === false) {
    const error = payload && payload.success === false ? payload.error : null;
    throw new WidgetApiError(
      error?.code ?? 'NETWORK_ERROR',
      error?.message ?? 'Could not reach the chat service',
      response.status,
    );
  }

  return payload.data;
}

export const widgetApi = {
  bootstrap: (input: {
    p: string;
    e?: string | null;
    token?: string | null;
    page?: { url?: string; title?: string; referrer?: string };
    screen?: { width: number; height: number };
    language?: string;
    timezone?: string;
  }) =>
    request<BootstrapResponse>('/widget/session', {
      method: 'POST',
      body: { ...input, token: input.token ?? undefined, e: input.e ?? undefined },
    }),

  identify: (token: string, traits: Record<string, string | undefined>) =>
    request<void>('/widget/identify', { method: 'POST', body: traits, token }),

  pageView: (token: string, page: { url: string; title?: string }) =>
    request<void>('/widget/page-view', { method: 'POST', body: page, token }),

  signUpload: (
    token: string,
    input: { conversationId: string; fileName: string; byteSize: number },
  ) =>
    request<{ attachmentId: string; uploadUrl: string; expiresInSeconds: number }>(
      '/widget/uploads/sign',
      { method: 'POST', body: input, token },
    ),

  confirmUpload: (token: string, attachmentId: string, clientMessageId: string) =>
    request<{ message: MessageDto; attachment: MessageAttachment }>(
      `/widget/uploads/${attachmentId}/confirm`,
      { method: 'POST', body: { clientMessageId }, token },
    ),

  attachmentUrl: (token: string, attachmentId: string) =>
    request<{ url: string; expiresInSeconds: number }>(`/widget/attachments/${attachmentId}/url`, {
      token,
    }),

  /** Leave a message when nobody is available. The server decides what the form may contain. */
  /**
   * Leave a message. With a `conversationId` it continues the chat the AI assistant offered a
   * ticket in, and the ticket attaches to that chat rather than opening a new one.
   */
  /** Thumbs up or down on an AI reply; null takes it back. */
  feedback: (token: string, messageId: string, rating: 'up' | 'down' | null) =>
    request<{ messageId: string; rating: 'up' | 'down' | null }>(
      `/widget/messages/${messageId}/feedback`,
      {
        method: 'POST',
        body: { rating },
        token,
      },
    ),

  offlineMessage: (token: string, values: Record<string, string>, conversationId?: string) =>
    request<{ conversationId: string; ticketNumber?: number }>('/widget/offline-message', {
      method: 'POST',
      body: { values, ...(conversationId ? { conversationId } : {}) },
      token,
    }),

  // --- voice calls -----------------------------------------------------------

  /**
   * The visitor presses Call.
   *
   * The pre-chat answers travel with it when the call opens the conversation, exactly as they
   * travel with a first message. Everything after this - the ringing, the answer, the end -
   * arrives over the socket as `call:updated`.
   */
  startCall: (
    token: string,
    input: { preChat?: Record<string, string>; language?: VoiceLanguage },
  ) =>
    request<CallStartResponse>('/widget/calls', {
      method: 'POST',
      body: {
        ...(input.preChat ? { preChat: input.preChat } : {}),
        ...(input.language ? { language: input.language } : {}),
      },
      token,
    }),

  /** The visitor's live call, if any - asked on load so a reload does not lose a call. */
  currentCall: (token: string) =>
    request<CurrentCallResponse | null>('/widget/calls/current', { token }),

  call: (token: string, callId: string) => request<CallDto>(`/widget/calls/${callId}`, { token }),

  /** The panel is in the media room. The server marks the call active once both sides are. */
  callJoined: (token: string, callId: string) =>
    request<CallDto>(`/widget/calls/${callId}/joined`, { method: 'POST', token }),

  /** Hang up: while it rings, or mid-call. */
  endCall: (token: string, callId: string) =>
    request<CallDto>(`/widget/calls/${callId}/end`, { method: 'POST', token }),
};
