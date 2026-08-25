import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from '@smartchat/validation';
import { AppError, ErrorCode } from '@smartchat/types';
import { UserRepository } from '@smartchat/core';
import { z } from 'zod';
import type { Container } from '../container.js';
import { requireSession, requireUser } from '../plugins/auth.js';
import {
  clearAuthCookies,
  setActiveAccountCookie,
  setCsrfCookie,
  setSessionCookie,
} from '../lib/cookies.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams } from '../lib/validate.js';
import { toAccountDto, toSessionDto, toUserDto } from './dto.js';

export async function authRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const cookieOptions = {
    secure: container.config.COOKIE_SECURE,
    domain: container.config.COOKIE_DOMAIN || undefined,
  };

  function meta(request: Parameters<typeof requireUser>[0]) {
    return {
      requestId: request.requestId,
      ip: request.clientIp,
      userAgent: request.headers['user-agent'],
    };
  }

  // ---------------------------------------------------------------------------
  app.post('/auth/register', async (request, reply) => {
    await app.rateLimit(request, 'register');
    const input = parseBody(registerSchema, request.body);
    // A second, narrower limit keyed on the address: one IP may legitimately create several
    // accounts, but one address repeatedly attempting to register is not a legitimate pattern.
    await app.rateLimit(request, 'registerEmail', `email:${input.email}`);

    const result = await container.auth.register(input, meta(request));

    setSessionCookie(reply, result.session.token, result.session.expiresAt, cookieOptions);
    setCsrfCookie(reply, result.session.csrfToken, result.session.expiresAt, cookieOptions);
    setActiveAccountCookie(reply, result.account.id, result.session.expiresAt, cookieOptions);

    return created(reply, {
      user: toUserDto(result.user),
      account: toAccountDto(result.account),
      requiresEmailVerification: result.requiresEmailVerification,
    });
  });

  // ---------------------------------------------------------------------------
  app.post('/auth/login', async (request, reply) => {
    const input = parseBody(loginSchema, request.body);

    // Two limits on purpose: per-IP stops a single host spraying many accounts, per-email stops a
    // distributed attack concentrating on one account.
    await app.rateLimit(request, 'login');
    await app.rateLimit(request, 'login', `email:${input.email}`);

    const result = await container.auth.login(input, meta(request));
    const accounts = await container.accounts.listForUser(result.user.id);

    setSessionCookie(reply, result.session.token, result.session.expiresAt, cookieOptions);
    setCsrfCookie(reply, result.session.csrfToken, result.session.expiresAt, cookieOptions);
    if (accounts[0]) {
      setActiveAccountCookie(reply, accounts[0].id, result.session.expiresAt, cookieOptions);
    }

    return ok(reply, { user: toUserDto(result.user), accounts });
  });

  // ---------------------------------------------------------------------------
  app.post('/auth/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const token = request.cookies['sc_session'];
    if (token) await container.auth.logout(token, meta(request));
    clearAuthCookies(reply, cookieOptions);
    return noContent(reply);
  });

  // ---------------------------------------------------------------------------
  app.get('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const accounts = await container.accounts.listForUser(user.id);
    const activeAccountId = request.cookies['sc_account'] ?? accounts[0]?.id ?? null;

    return ok(reply, {
      user: toUserDto(user),
      accounts,
      activeAccountId,
      csrfToken: requireSession(request).csrfSecret,
    });
  });

  // ---------------------------------------------------------------------------
  app.patch('/auth/profile', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(updateProfileSchema, request.body);
    const updated = await new UserRepository(container.db).updateProfile(user.id, input);
    return ok(reply, { user: toUserDto(updated) });
  });

  // ---------------------------------------------------------------------------
  app.post('/auth/verify-email', async (request, reply) => {
    await app.rateLimit(request, 'emailToken');
    const input = parseBody(verifyEmailSchema, request.body);
    const user = await container.auth.verifyEmail(input.token, meta(request));
    return ok(reply, { user: toUserDto(user) });
  });

  app.post('/auth/resend-verification', async (request, reply) => {
    const input = parseBody(resendVerificationSchema, request.body);
    await app.rateLimit(request, 'resendVerification', `email:${input.email}`);
    await container.auth.resendVerification(input.email, meta(request));
    // Always the same response: whether this address exists is not the caller's business.
    return ok(reply, { sent: true });
  });

  // ---------------------------------------------------------------------------
  app.post('/auth/forgot-password', async (request, reply) => {
    const input = parseBody(forgotPasswordSchema, request.body);
    await app.rateLimit(request, 'forgotPassword');
    await app.rateLimit(request, 'forgotPassword', `email:${input.email}`);
    await container.auth.requestPasswordReset(input.email, meta(request));
    return ok(reply, { sent: true });
  });

  app.post('/auth/reset-password', async (request, reply) => {
    await app.rateLimit(request, 'emailToken');
    const input = parseBody(resetPasswordSchema, request.body);
    await container.auth.resetPassword(input, meta(request));
    clearAuthCookies(reply, cookieOptions);
    return ok(reply, { reset: true });
  });

  app.post('/auth/change-password', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const session = requireSession(request);
    const input = parseBody(changePasswordSchema, request.body);
    await container.auth.changePassword(user.id, input, session.id, meta(request));
    return ok(reply, { changed: true });
  });

  // ---------------------------------------------------------------------------
  app.get('/auth/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const current = requireSession(request);
    const sessions = await container.auth.listSessions(user.id);
    return ok(reply, { sessions: sessions.map((s) => toSessionDto(s, current.id)) });
  });

  app.delete('/auth/sessions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseParams(z.object({ id: z.string().uuid() }), request.params);
    const revoked = await container.auth.revokeSession(user.id, id, meta(request));
    if (!revoked) throw new AppError(ErrorCode.NOT_FOUND, 'Session not found');
    if (id === requireSession(request).id) clearAuthCookies(reply, cookieOptions);
    return noContent(reply);
  });

  // ---------------------------------------------------------------------------
  app.post('/auth/switch-account', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const session = requireSession(request);
    const { accountId } = parseBody(z.object({ accountId: z.string().uuid() }), request.body);

    // Membership is verified before the cookie is written, so switching cannot be used to point
    // at an account the user does not belong to.
    const membership = await container.accounts.requireMembership(user.id, accountId);
    setActiveAccountCookie(reply, membership.accountId, session.expiresAt, cookieOptions);

    return ok(reply, { account: toAccountDto(membership.account) });
  });
}
