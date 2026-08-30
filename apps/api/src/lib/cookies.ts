import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'sc_session';
export const CSRF_COOKIE = 'sc_csrf';
export const ACCOUNT_COOKIE = 'sc_account';

export interface CookieOptions {
  secure: boolean;
  domain?: string | undefined;
}

/**
 * The session cookie is httpOnly, so no script — ours or an injected one — can read it.
 *
 * `SameSite=Lax` is the deliberate choice over `Strict`: it still blocks cross-site POSTs (the
 * CSRF vector) while letting a person who clicks a verification link in their email arrive already
 * signed in, which `Strict` would break.
 */
export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  options: CookieOptions,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    expires: expiresAt,
    ...(options.domain ? { domain: options.domain } : {}),
  });
}

/**
 * The CSRF cookie is deliberately readable by script: the dashboard reads it and echoes it in a
 * header. An attacker's page can force a request but cannot read this cookie to set the header,
 * which is what makes the double-submit work.
 */
export function setCsrfCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  options: CookieOptions,
): void {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    expires: expiresAt,
    ...(options.domain ? { domain: options.domain } : {}),
  });
}

export function setActiveAccountCookie(
  reply: FastifyReply,
  accountId: string,
  expiresAt: Date,
  options: CookieOptions,
): void {
  reply.setCookie(ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    expires: expiresAt,
    ...(options.domain ? { domain: options.domain } : {}),
  });
}

export function clearAuthCookies(reply: FastifyReply, options: CookieOptions): void {
  for (const name of [SESSION_COOKIE, CSRF_COOKIE, ACCOUNT_COOKIE]) {
    reply.clearCookie(name, {
      path: '/',
      ...(options.domain ? { domain: options.domain } : {}),
    });
  }
}

export const PLATFORM_SESSION_COOKIE = 'sc_platform';

/**
 * The platform console's own cookie.
 *
 * A different name and a different path from the tenant session, which matters more than it looks:
 * signing out of the dashboard must not sign an operator out of the console, and - far more
 * importantly - a stolen tenant session must never be usable as a platform one. Two names make
 * that structural rather than a matter of remembering to check.
 *
 * `SameSite=Strict` here, not `Lax`. The console has no email links to arrive from, so the
 * looser setting buys nothing and costs the strongest CSRF protection available.
 */
export function setPlatformSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  options: CookieOptions,
): void {
  reply.setCookie(PLATFORM_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: options.secure,
    path: '/',
    expires: expiresAt,
    ...(options.domain ? { domain: options.domain } : {}),
  });
}

export function clearPlatformSessionCookie(reply: FastifyReply, options: CookieOptions): void {
  reply.clearCookie(PLATFORM_SESSION_COOKIE, {
    path: '/',
    ...(options.domain ? { domain: options.domain } : {}),
  });
}
