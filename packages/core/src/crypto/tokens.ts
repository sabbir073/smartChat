import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets we hand out (session cookies, verification links, API keys) are 256 bits of CSPRNG
 * output, base64url-encoded so they survive URLs, headers and copy-paste unchanged.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Only the hash is stored. A database dump therefore does not contain a single usable session
 * cookie, reset link or API key.
 *
 * SHA-256 (not Argon2) is correct here: these are already high-entropy random values, so there is
 * nothing to brute-force, and lookups must be fast enough to run on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison. Length differences are handled without leaking through timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still do the comparison so failure time does not depend on where the mismatch is.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/** Short, human-readable prefix stored alongside an API key so the UI can show `sc_live_a1b2…`. */
export function tokenFingerprint(token: string, length = 8): string {
  return hashToken(token).slice(0, length);
}
