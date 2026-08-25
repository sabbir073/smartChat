/**
 * The visitor's token, kept in the panel's own origin.
 *
 * This is the reason the panel is a cross-origin iframe rather than markup injected into the host
 * page: `localStorage` here belongs to us, so the customer's site - and anything else running on
 * it - cannot read the token that identifies their visitor to us.
 *
 * Every access is guarded: Safari in private mode, embedded webviews and strict cookie settings
 * all throw on `localStorage`, and a chat widget must degrade to "no history" rather than crash.
 */
const TOKEN_PREFIX = 'smartchat.token.';

export function readToken(publicId: string): string | null {
  try {
    return window.localStorage.getItem(TOKEN_PREFIX + publicId);
  } catch {
    return null;
  }
}

export function writeToken(publicId: string, token: string): void {
  try {
    window.localStorage.setItem(TOKEN_PREFIX + publicId, token);
  } catch {
    /* storage unavailable: the visitor simply starts fresh next time */
  }
}

export function clearToken(publicId: string): void {
  try {
    window.localStorage.removeItem(TOKEN_PREFIX + publicId);
  } catch {
    /* nothing to do */
  }
}
