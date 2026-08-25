import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The credential the widget holds.
 *
 * Deliberately not JWT. A JWT carries its algorithm in the header, which is the root of the
 * `alg: none` and RS256/HS256 confusion families - and we gain nothing from that flexibility for a
 * token only we ever issue and only we ever verify. This format has no negotiable algorithm: the
 * payload is signed with HMAC-SHA256 and nothing in the token can change how it is verified.
 *
 *   <base64url(payload)>.<base64url(hmac-sha256(payload))>
 *
 * The token is stored in the widget iframe's `localStorage`, which is our own origin - so the
 * customer's page cannot read it even though the widget runs inside their site.
 */

export const VISITOR_TOKEN_VERSION = 1;

export interface VisitorTokenPayload {
  /** Format version, so the shape can change without ambiguity. */
  v: number;
  accountId: string;
  propertyId: string;
  visitorId: string;
  sessionId: string;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expires at, seconds since epoch. */
  exp: number;
}

export interface IssueVisitorTokenInput {
  accountId: string;
  propertyId: string;
  visitorId: string;
  sessionId: string;
  ttlSeconds: number;
  now: Date;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueVisitorToken(input: IssueVisitorTokenInput, secret: string): string {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const payload: VisitorTokenPayload = {
    v: VISITOR_TOKEN_VERSION,
    accountId: input.accountId,
    propertyId: input.propertyId,
    visitorId: input.visitorId,
    sessionId: input.sessionId,
    iat: issuedAt,
    exp: issuedAt + input.ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export type VisitorTokenFailure =
  'malformed' | 'bad_signature' | 'expired' | 'wrong_version' | 'property_mismatch';

export type VisitorTokenResult =
  { ok: true; payload: VisitorTokenPayload } | { ok: false; reason: VisitorTokenFailure };

export interface VerifyVisitorTokenOptions {
  /** The property the request claims to be for. A token for another property is rejected. */
  expectedPropertyId?: string;
  now: Date;
}

export function verifyVisitorToken(
  token: string,
  secret: string,
  options: VerifyVisitorTokenOptions,
): VisitorTokenResult {
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }

  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return { ok: false, reason: 'malformed' };

  const encoded = token.slice(0, separator);
  const provided = token.slice(separator + 1);

  // Signature first, always. Nothing inside the payload is parsed - let alone trusted - until we
  // know we produced it.
  const expected = sign(encoded, secret);
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length)
    return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: VisitorTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as VisitorTokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.accountId !== 'string' ||
    typeof payload.propertyId !== 'string' ||
    typeof payload.visitorId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== VISITOR_TOKEN_VERSION) return { ok: false, reason: 'wrong_version' };
  if (payload.exp * 1000 <= options.now.getTime()) return { ok: false, reason: 'expired' };
  if (options.expectedPropertyId && payload.propertyId !== options.expectedPropertyId) {
    return { ok: false, reason: 'property_mismatch' };
  }

  return { ok: true, payload };
}

/** 30 days: long enough that a returning visitor keeps their history, short enough to rotate. */
export const VISITOR_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
