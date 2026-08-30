import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures.
 *
 * The receiver's problem is "did SmartChat really send this, and is it fresh?". A bare HMAC of the
 * body answers only the first: anybody who captures one delivery can replay it forever. So the
 * timestamp is signed *with* the body and sent alongside, and the receiver checks both.
 *
 * The header format is deliberately the one several well-known products use:
 *
 *     X-SmartChat-Signature: t=1730000000,v1=9f86d0818...
 *
 * Not because copying is a virtue, but because an integrator has almost certainly written this
 * verification code before, and a familiar shape is one they are less likely to get wrong. `v1` is
 * a version, so a future scheme can be added without breaking every existing endpoint on the day
 * it ships.
 */

export const SIGNATURE_HEADER = 'x-smartchat-signature';
export const EVENT_HEADER = 'x-smartchat-event';
export const DELIVERY_HEADER = 'x-smartchat-delivery';

/** How much clock skew a receiver should tolerate. Five minutes, like everybody else. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, payload: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Verify a signature header the way a receiver would.
 *
 * Exported and tested, because a signing scheme nobody has written the *other* half of is a
 * scheme nobody has checked. This is the reference implementation our documentation points at,
 * and the e2e suite uses it to verify a real delivery rather than trusting that we signed it.
 */
export function verifySignature(
  secret: string,
  payload: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): { valid: boolean; reason?: string } {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!Number.isFinite(timestamp) || !provided) return { valid: false, reason: 'malformed' };

  // Checked before the HMAC, so a replay is rejected on age rather than on cryptography.
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'stale' };

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Compare something of equal length anyway, so a wrong-length signature does not return
    // measurably faster than a wrong-value one.
    timingSafeEqual(a, a);
    return { valid: false, reason: 'mismatch' };
  }
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
}

/**
 * Backoff for a failed delivery.
 *
 * Roughly exponential, capped, and it stops. An endpoint that has been broken for six hours is
 * broken; retrying it every minute forever turns one dead integration into a permanent load on
 * this system and on theirs.
 */
export const MAX_DELIVERY_ATTEMPTS = 6;

export function nextAttemptDelayMs(attempts: number): number {
  const schedule = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
  return schedule[Math.min(attempts, schedule.length - 1)] ?? 7_200_000;
}
