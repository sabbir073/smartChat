import { API_URL } from './runtime.js';
import type { WidgetConfig } from '@smartchat/validation';
import type { MessageAttachment, MessageDto } from './types.js';

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

  const response = await fetch(`${API_URL}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'omit',
    mode: 'cors',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

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
    token?: string | null;
    page?: { url?: string; title?: string; referrer?: string };
    screen?: { width: number; height: number };
    language?: string;
    timezone?: string;
  }) =>
    request<BootstrapResponse>('/widget/session', {
      method: 'POST',
      body: { ...input, token: input.token ?? undefined },
    }),

  identify: (token: string, traits: Record<string, string | undefined>) =>
    request<void>('/widget/identify', { method: 'POST', body: traits, token }),

  pageView: (token: string, page: { url: string; title?: string }) =>
    request<void>('/widget/page-view', { method: 'POST', body: page, token }),

  signUpload: (token: string, input: { conversationId: string; fileName: string; byteSize: number }) =>
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
  offlineMessage: (token: string, values: Record<string, string>) =>
    request<{ conversationId: string }>('/widget/offline-message', {
      method: 'POST',
      body: { values },
      token,
    }),
};
