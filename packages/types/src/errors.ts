/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API contract: clients branch on `code`, never on `message`.
 * Adding a code is additive and safe; changing or removing one is a breaking change.
 */
export const ErrorCode = {
  // --- generic -------------------------------------------------------------
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- authentication ------------------------------------------------------
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  WEAK_PASSWORD: 'WEAK_PASSWORD',

  // --- authorisation -------------------------------------------------------
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',

  // --- domain --------------------------------------------------------------
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  PROPERTY_NOT_FOUND: 'PROPERTY_NOT_FOUND',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  CONVERSATION_CLOSED: 'CONVERSATION_CLOSED',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  VISITOR_NOT_FOUND: 'VISITOR_NOT_FOUND',
  CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  ARTICLE_NOT_FOUND: 'ARTICLE_NOT_FOUND',
  WEBHOOK_NOT_FOUND: 'WEBHOOK_NOT_FOUND',
  TRIGGER_NOT_FOUND: 'TRIGGER_NOT_FOUND',
  SHORTCUT_NOT_FOUND: 'SHORTCUT_NOT_FOUND',
  SHORTCUT_KEY_TAKEN: 'SHORTCUT_KEY_TAKEN',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  MEMBER_ALREADY_EXISTS: 'MEMBER_ALREADY_EXISTS',
  DUPLICATE_SLUG: 'DUPLICATE_SLUG',
  VISITOR_BANNED: 'VISITOR_BANNED',

  // --- uploads -------------------------------------------------------------
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',

  // --- entitlements --------------------------------------------------------
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  /**
   * The account's service is reduced to read-only: an unpaid subscription past its grace window,
   * or one that was cancelled. 402 rather than 403 because it is answerable with money, and the
   * message says plainly that nothing has been deleted - which is true, and is the first thing
   * somebody seeing this wants to know.
   */
  SUBSCRIPTION_PAUSED: 'SUBSCRIPTION_PAUSED',
  /**
   * Switched off by the platform, not by the plan.
   *
   * Distinct from FEATURE_NOT_AVAILABLE on purpose: that one is 402 and means "upgrade", which
   * would be an infuriating thing to tell somebody during an incident on our side. This is 503,
   * which is what it actually is - and it tells a client that retrying later is reasonable.
   */
  TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status for each error code. Anything unmapped is treated as 500. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  INTERNAL_ERROR: 500,
  VALIDATION_FAILED: 422,
  MALFORMED_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,

  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  EMAIL_NOT_VERIFIED: 403,
  EMAIL_ALREADY_REGISTERED: 409,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 403,
  WEAK_PASSWORD: 422,

  FORBIDDEN: 403,
  PERMISSION_DENIED: 403,
  ORIGIN_NOT_ALLOWED: 403,
  CSRF_TOKEN_INVALID: 403,

  ACCOUNT_NOT_FOUND: 404,
  PROPERTY_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  CONVERSATION_CLOSED: 409,
  MESSAGE_NOT_FOUND: 404,
  VISITOR_NOT_FOUND: 404,
  CONTACT_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  ARTICLE_NOT_FOUND: 404,
  WEBHOOK_NOT_FOUND: 404,
  TRIGGER_NOT_FOUND: 404,
  SHORTCUT_NOT_FOUND: 404,
  SHORTCUT_KEY_TAKEN: 409,
  MEMBER_NOT_FOUND: 404,
  MEMBER_ALREADY_EXISTS: 409,
  DUPLICATE_SLUG: 409,
  VISITOR_BANNED: 403,

  FILE_TYPE_NOT_ALLOWED: 415,
  FILE_TOO_LARGE: 413,
  UPLOAD_FAILED: 500,

  PLAN_LIMIT_REACHED: 402,
  FEATURE_NOT_AVAILABLE: 402,
  SUBSCRIPTION_PAUSED: 402,
  TEMPORARILY_UNAVAILABLE: 503,
};

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
  requestId?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * The single error type thrown by domain and transport code.
 *
 * `message` is always safe to show a user. Anything sensitive belongs in `context`, which is
 * logged and never serialised to a client.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details: ErrorDetail[] | undefined;
  public readonly context: Record<string, unknown> | undefined;
  public readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: {
      details?: ErrorDetail[];
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message ?? DEFAULT_MESSAGES[code] ?? 'Unexpected error');
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.details = options?.details;
    this.context = options?.context;
    this.expose = this.status < 500;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, AppError);
  }

  static notFound(code: ErrorCode = ErrorCode.NOT_FOUND, context?: Record<string, unknown>) {
    return new AppError(code, undefined, context ? { context } : undefined);
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      code: this.code,
      message: this.expose ? this.message : 'An unexpected error occurred',
      ...(this.details ? { details: this.details } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
}

const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INTERNAL_ERROR: 'An unexpected error occurred',
  VALIDATION_FAILED: 'The request contains invalid values',
  MALFORMED_REQUEST: 'The request could not be understood',
  NOT_FOUND: 'Not found',
  CONFLICT: 'The request conflicts with the current state',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  PAYLOAD_TOO_LARGE: 'The request payload is too large',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable',
  UNAUTHENTICATED: 'Authentication is required',
  INVALID_CREDENTIALS: 'Incorrect email or password',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  EMAIL_NOT_VERIFIED: 'Please verify your email address to continue',
  EMAIL_ALREADY_REGISTERED: 'An account with this email already exists',
  INVALID_TOKEN: 'This link is invalid',
  TOKEN_EXPIRED: 'This link has expired',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again later.',
  ACCOUNT_SUSPENDED: 'This account has been suspended',
  WEAK_PASSWORD: 'This password does not meet the minimum requirements',
  FORBIDDEN: 'You do not have access to this resource',
  PERMISSION_DENIED: 'You do not have permission to perform this action',
  ORIGIN_NOT_ALLOWED: 'This domain is not authorised for this property',
  CSRF_TOKEN_INVALID: 'Your request could not be verified. Please refresh and try again.',
  ACCOUNT_NOT_FOUND: 'Account not found',
  PROPERTY_NOT_FOUND: 'Property not found',
  CONVERSATION_NOT_FOUND: 'Conversation not found',
  CONVERSATION_CLOSED: 'This conversation is closed',
  MESSAGE_NOT_FOUND: 'Message not found',
  VISITOR_NOT_FOUND: 'Visitor not found',
  CONTACT_NOT_FOUND: 'Contact not found',
  TICKET_NOT_FOUND: 'Ticket not found',
  ARTICLE_NOT_FOUND: 'Article not found',
  WEBHOOK_NOT_FOUND: 'Webhook not found',
  MEMBER_NOT_FOUND: 'Team member not found',
  MEMBER_ALREADY_EXISTS: 'That person is already on this team',
  DUPLICATE_SLUG: 'That slug is already in use',
  VISITOR_BANNED: 'Chat is not available',
  FILE_TYPE_NOT_ALLOWED: 'This file type is not allowed',
  FILE_TOO_LARGE: 'This file is too large',
  UPLOAD_FAILED: 'The upload could not be completed',
  PLAN_LIMIT_REACHED: 'Your plan limit has been reached',
  FEATURE_NOT_AVAILABLE: 'This feature is not available on your plan',
  SUBSCRIPTION_PAUSED:
    'This account is read-only until the subscription is renewed. Nothing has been deleted.',
  TEMPORARILY_UNAVAILABLE: 'This is temporarily unavailable. Please try again shortly.',
};
