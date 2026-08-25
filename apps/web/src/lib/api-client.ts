import type { ApiErrorBody, ErrorCode } from '@smartchat/types';
import { runtimeConfig } from './runtime-config';

/**
 * The browser's single door to the API.
 *
 * Everything the dashboard knows about the backend goes through here: credentials, the CSRF
 * header, the active-account header, and error normalisation. No component ever calls `fetch`
 * directly, so there is one place to change when any of that evolves.
 */

/** Resolved per call rather than at module load, so it is correct in both server and browser. */
const apiBase = () => runtimeConfig().apiUrl;

const CSRF_COOKIE = 'sc_csrf';

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    public readonly status: number,
    public readonly details?: { path: string; message: string }[],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages keyed by form field, ready to hand to a form. */
  fieldErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      const field = detail.path.replace(/^body\./, '');
      if (!errors[field]) errors[field] = detail.message;
    }
    return errors;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** A repeated parameter (`?tags=a&tags=b`) is expressed as an array; see below. */
export type QueryValue = string | number | boolean | undefined | string[];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  accountId?: string;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const url = new URL(`${apiBase()}/api/v1${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    // An array becomes repeated parameters rather than one comma-joined value: a tag may itself
    // contain a comma, and joining would silently split it into two different tags.
    if (Array.isArray(value)) {
      for (const entry of value) if (entry !== '') url.searchParams.append(key, entry);
      continue;
    }
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  // The CSRF token is read from a script-readable cookie and echoed in a header. A cross-site
  // page can trigger the request but cannot read the cookie, so it cannot set this header.
  const method = options.method ?? 'GET';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.accountId) headers['x-account-id'] = options.accountId;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
      0,
    );
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      'MALFORMED_RESPONSE',
      'The server returned an unexpected response',
      response.status,
    );
  }

  const envelope = payload as
    | { success: true; data: T; meta?: Record<string, unknown> }
    | { success: false; error: ApiErrorBody };

  if (!response.ok || envelope.success === false) {
    const error = (envelope as { error?: ApiErrorBody }).error;
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong',
      response.status,
      error?.details,
      error?.requestId,
    );
  }

  return envelope.meta ? { data: envelope.data, meta: envelope.meta } : { data: envelope.data };
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
