import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proof of which page the widget is embedded in.
 *
 * The problem it solves is structural, not incidental. The widget has two halves on two different
 * origins: a loader that runs *in the customer's page*, and a panel that runs in an iframe on our
 * own CDN host. Only the loader's requests carry the customer's site in the browser-set `Origin`
 * header. The panel's carry ours — `cdn.example.com` — because that is genuinely where that
 * document came from.
 *
 * So checking `Origin` on the panel's bootstrap call asks the wrong question and always gets the
 * same wrong answer: with domain enforcement switched on, every widget on every authorised site
 * was refused, because the origin being checked was never the customer's and never in their list.
 *
 * The fix is to check the origin once, where a real one exists, and carry that decision forward
 * in something the panel cannot forge. `/widget/config` is called by the loader, sees the true
 * origin, and — when that origin is allowed — mints one of these. The loader hands it to the panel
 * through the iframe URL, the panel presents it on bootstrap, and the host inside it is re-checked
 * against the property's current domain list.
 *
 * Signed exactly like the visitor token, and for the same reason: HMAC-SHA256 over a base64url
 * payload, with no algorithm field for anybody to negotiate downwards.
 *
 *   <base64url(payload)>.<base64url(hmac-sha256(payload))>
 *
 * Short-lived on purpose. It is not a session; it exists to survive the few seconds between the
 * loader's config call and the panel's first request, and a short life bounds how long a removed
 * domain keeps working.
 */

export const EMBED_TICKET_VERSION = 1;

/** Ten minutes: long enough for a delayed launcher and a slow visitor, short enough to matter. */
export const EMBED_TICKET_TTL_SECONDS = 10 * 60;

export interface EmbedTicketPayload {
  v: number;
  /** The property this ticket was issued for. */
  p: string;
  /** The host the browser reported for the embedding page, lowercased. */
  h: string;
  iat: number;
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueEmbedTicket(
  input: { publicId: string; host: string; ttlSeconds?: number; now: Date },
  secret: string,
): string {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const payload: EmbedTicketPayload = {
    v: EMBED_TICKET_VERSION,
    p: input.publicId,
    h: input.host.toLowerCase(),
    iat: issuedAt,
    exp: issuedAt + (input.ttlSeconds ?? EMBED_TICKET_TTL_SECONDS),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export type EmbedTicketFailure =
  'malformed' | 'bad_signature' | 'expired' | 'wrong_version' | 'property_mismatch';

export type EmbedTicketResult =
  { ok: true; payload: EmbedTicketPayload } | { ok: false; reason: EmbedTicketFailure };

export function verifyEmbedTicket(
  ticket: string,
  secret: string,
  options: { now: Date; expectedPublicId?: string },
): EmbedTicketResult {
  if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 2048) {
    return { ok: false, reason: 'malformed' };
  }

  const separator = ticket.indexOf('.');
  if (separator <= 0 || separator === ticket.length - 1) return { ok: false, reason: 'malformed' };

  const encoded = ticket.slice(0, separator);
  const provided = ticket.slice(separator + 1);

  // Signature before parsing, always. Nothing inside is read until we know we wrote it.
  const expected = sign(encoded, secret);
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: EmbedTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as EmbedTicketPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.p !== 'string' ||
    typeof payload.h !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== EMBED_TICKET_VERSION) return { ok: false, reason: 'wrong_version' };
  if (payload.exp * 1000 <= options.now.getTime()) return { ok: false, reason: 'expired' };
  if (options.expectedPublicId && payload.p !== options.expectedPublicId) {
    return { ok: false, reason: 'property_mismatch' };
  }

  return { ok: true, payload };
}
