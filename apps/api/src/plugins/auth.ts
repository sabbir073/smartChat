import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCode, type TenantContext } from '@smartchat/types';
import { buildTenantContext, safeEqual } from '@smartchat/core';
import type { Session, User } from '@smartchat/database';
import type { Container } from '../container.js';
import { ACCOUNT_COOKIE, CSRF_COOKIE, SESSION_COOKIE, clearAuthCookies } from '../lib/cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    currentUser: User | null;
    tenant: TenantContext | null;
  }
  interface FastifyInstance {
    /**
     * Requires a live session. Populates `request.session` and `request.currentUser`.
     *
     * Takes the reply so a rejected session can have its cookie cleared on the way out - see
     * `loadSession`.
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Requires a session **and** a resolved account membership. Populates `request.tenant`. */
    authenticateTenant(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Requires a session with a verified email address. */
    requireVerifiedEmail(request: FastifyRequest): Promise<void>;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pull an API key out of the Authorization header, if there is one.
 *
 * Deliberately narrow: only `Bearer sck_...`. A visitor's widget credential is also a bearer
 * token, and treating "any bearer token" as a possible API key would mean every widget request
 * takes a trip through the key table before failing.
 */
function apiKeyFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value?.startsWith('sck_')) return null;
  return value.trim();
}

/**
 * Double-submit CSRF check.
 *
 * The session cookie is `SameSite=Lax`, which already blocks cross-site form posts. This is the
 * second layer: the caller must echo a value that only same-origin script can read, so a request
 * forged from another site fails even if the browser's SameSite handling is bypassed.
 */
function assertCsrf(request: FastifyRequest, session: Session): void {
  if (SAFE_METHODS.has(request.method)) return;

  const header = request.headers['x-csrf-token'];
  const provided = typeof header === 'string' ? header : '';
  const cookie = request.cookies[CSRF_COOKIE] ?? '';

  if (
    !provided ||
    !cookie ||
    !safeEqual(provided, cookie) ||
    !safeEqual(provided, session.csrfSecret)
  ) {
    throw new AppError(ErrorCode.CSRF_TOKEN_INVALID);
  }
}

export const authPlugin = fp<{ container: Container }>(
  async (app, options) => {
    const { container } = options;

    app.decorateRequest('session', null);
    app.decorateRequest('currentUser', null);
    app.decorateRequest('tenant', null);

    async function loadSession(request: FastifyRequest, reply?: FastifyReply): Promise<void> {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) throw new AppError(ErrorCode.UNAUTHENTICATED);

      const session = await container.auth.resolveSession(token);
      if (!session) {
        /**
         * Clear the dead cookie on the way out.
         *
         * The session cookie is HttpOnly, so the browser cannot drop it itself, and the dashboard
         * middleware routes on the cookie being *present* rather than valid - it has no way to
         * check. Leaving a rejected cookie in place therefore strands the person: every page says
         * "your session has expired, sign in again", and /login bounces them back because the
         * cookie is still there. The server is the only party that can end this, and this is the
         * moment it knows.
         */
        if (reply) {
          clearAuthCookies(reply, {
            secure: container.config.COOKIE_SECURE,
            domain: container.config.COOKIE_DOMAIN || undefined,
          });
        }
        throw new AppError(ErrorCode.SESSION_EXPIRED);
      }

      assertCsrf(request, session);

      request.session = session;
      request.currentUser = session.user;
    }

    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      await loadSession(request, reply);
    });

    app.decorate('requireVerifiedEmail', async (request: FastifyRequest) => {
      if (!request.currentUser) await loadSession(request);
      if (!request.currentUser?.emailVerifiedAt) {
        throw new AppError(ErrorCode.EMAIL_NOT_VERIFIED);
      }
    });

    /**
     * Resolve which account this request acts on, then build the TenantContext.
     *
     * The account is *never* taken on trust: whichever id arrives, membership is re-checked
     * against the database on every request, so a forged cookie or header resolves to nothing.
     */
    app.decorate('authenticateTenant', async (request: FastifyRequest, reply: FastifyReply) => {
      /**
       * A key is another kind of actor, on the same routes.
       *
       * Not a parallel API with its own handlers - the same ones, reached with a smaller
       * permission set. That is what stops the two authorisation paths drifting apart: there is
       * only one, and a key simply carries fewer permissions into it.
       *
       * There is no CSRF check on this path, and that is correct rather than an omission: CSRF
       * exists because a browser attaches cookies to cross-site requests by itself. Nothing
       * attaches an Authorization header on anybody's behalf.
       */
      const presented = apiKeyFrom(request);
      if (presented) {
        const principal = await container.apiKeys.authenticate(presented);
        // One answer for every kind of refusal - unknown prefix, wrong secret, revoked, expired,
        // suspended account. Distinguishing them is how a key space gets enumerated.
        if (!principal) throw new AppError(ErrorCode.UNAUTHENTICATED);
        request.tenant = container.apiKeys.contextFor(
          principal,
          request.requestId,
          request.clientIp,
        );
        return;
      }

      if (!request.currentUser) await loadSession(request, reply);
      const user = request.currentUser;
      if (!user) throw new AppError(ErrorCode.UNAUTHENTICATED);

      const headerAccount = request.headers['x-account-id'];
      const requested =
        (typeof headerAccount === 'string' ? headerAccount : undefined) ??
        request.cookies[ACCOUNT_COOKIE];

      let accountId = requested;
      if (!accountId) {
        const memberships = await container.accounts.listForUser(user.id);
        accountId = memberships[0]?.id;
      }
      if (!accountId) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);

      const membership = await container.accounts.requireMembership(user.id, accountId);

      request.tenant = buildTenantContext({
        membership,
        requestId: request.requestId,
        ip: request.clientIp,
        userAgent: request.headers['user-agent'],
      });
    });
  },
  { name: 'auth', dependencies: ['request-context'] },
);

/** Narrowing helpers so handlers never repeat a null check the preHandler already guaranteed. */
export function requireUser(request: FastifyRequest): User {
  if (!request.currentUser) throw new AppError(ErrorCode.UNAUTHENTICATED);
  return request.currentUser;
}

export function requireTenant(request: FastifyRequest): TenantContext {
  if (!request.tenant) throw new AppError(ErrorCode.UNAUTHENTICATED);
  return request.tenant;
}

export function requireSession(request: FastifyRequest): Session {
  if (!request.session) throw new AppError(ErrorCode.UNAUTHENTICATED);
  return request.session;
}
