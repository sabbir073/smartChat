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

  // --- availability --------------------------------------------------------
  /**
   * The capability exists but is switched off for this website by its own configuration - the
   * offline form, say. Not a commercial answer: there are no plans and nothing to upgrade to.
   */
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  /**
   * Switched off by the platform, not by the customer.
   *
   * 503 rather than 403, because it is our outage and not their mistake - and it tells a client
   * that retrying later is reasonable.
   */
  TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE',

  // --- billing -------------------------------------------------------------
  /** The dashboard is locked for non-payment. Reading is allowed; changing anything is not. */
  BILLING_LOCKED: 'BILLING_LOCKED',
  /** The plan's ceiling for websites or seats has been reached. */
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  /** The plan does not include this capability at all. */
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  /** The operator has not entered Stripe keys yet, so nothing can be bought. */
  BILLING_NOT_CONFIGURED: 'BILLING_NOT_CONFIGURED',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  /** Stripe refused or could not be reached. The detail is in the log, never in the response. */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  /** No AI provider answered: the local model is down and no fallback is configured or working. */
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
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

  FEATURE_NOT_AVAILABLE: 403,
  TEMPORARILY_UNAVAILABLE: 503,
  BILLING_LOCKED: 402,
  PLAN_LIMIT_REACHED: 402,
  FEATURE_NOT_IN_PLAN: 402,
  BILLING_NOT_CONFIGURED: 503,
  PLAN_NOT_FOUND: 404,
  PAYMENT_PROVIDER_ERROR: 502,
  AI_UNAVAILABLE: 503,
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
/**
 * 5xx codes whose message is written for the person, not the log.
 *
 * A 5xx normally answers "An unexpected error occurred", because its message describes our
 * internals. These two describe somebody else's: payments are not set up on this installation,
 * or the payment provider declined to act. Both messages are composed here, never copied from the
 * upstream error, so they are safe to show and useless to hide.
 */
const EXPOSED_UPSTREAM_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.BILLING_NOT_CONFIGURED,
  ErrorCode.PAYMENT_PROVIDER_ERROR,
  ErrorCode.AI_UNAVAILABLE,
]);

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
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.details = options?.details;
    this.context = options?.context;
    this.expose = this.status < 500 || EXPOSED_UPSTREAM_CODES.has(code);
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

/**
 * The sentence a person reads when nothing more specific was written.
 *
 * Exhaustive by type, not by discipline. This was a `Partial` map, and three codes had quietly
 * been added without one - a missing trigger, a missing shortcut and a duplicate shortcut key all
 * answered "Unexpected error", which is both alarming and useless. `Record<ErrorCode, string>`
 * means a new code without a written sentence does not compile.
 */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
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
  TRIGGER_NOT_FOUND: 'That automation rule no longer exists',
  SHORTCUT_NOT_FOUND: 'That saved reply no longer exists',
  SHORTCUT_KEY_TAKEN: 'Another saved reply already uses that shortcut',
  MEMBER_NOT_FOUND: 'Team member not found',
  MEMBER_ALREADY_EXISTS: 'That person is already on this team',
  DUPLICATE_SLUG: 'That slug is already in use',
  VISITOR_BANNED: 'Chat is not available',
  FILE_TYPE_NOT_ALLOWED: 'This file type is not allowed',
  FILE_TOO_LARGE: 'This file is too large',
  UPLOAD_FAILED: 'The upload could not be completed',
  FEATURE_NOT_AVAILABLE: 'That is switched off for this website',
  TEMPORARILY_UNAVAILABLE: 'This is temporarily unavailable. Please try again shortly.',
  BILLING_LOCKED:
    'Your subscription needs attention before you can make changes. Update your payment details to continue.',
  PLAN_LIMIT_REACHED: 'Your plan has reached its limit for this. Upgrade to add more.',
  FEATURE_NOT_IN_PLAN: 'This is not included in your current plan.',
  BILLING_NOT_CONFIGURED: 'Payments are not set up on this installation yet.',
  PLAN_NOT_FOUND: 'That plan is not available',
  PAYMENT_PROVIDER_ERROR: 'The payment provider could not complete that. Please try again shortly.',
  AI_UNAVAILABLE: 'The AI service is not reachable right now.',
};
