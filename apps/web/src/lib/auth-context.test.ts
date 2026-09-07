import { describe, expect, it } from 'vitest';
import { shouldRedirectToLogin } from './auth-context';

/**
 * The bug this pins, which reached production.
 *
 * `AuthProvider` sits in the root layout, so it calls `/auth/me` on *every* page - the marketing
 * site included. For anybody not signed in that call correctly returns 401, and the handler used
 * to send them to `/login?expired=1` unless the path already began with `/login`.
 *
 * The result: a stranger opening the homepage was bounced to a sign-in screen claiming their
 * session had expired. They had never had one. The public site was unreachable for exactly the
 * people it exists to reach.
 *
 * No HTTP-level check catches this. The server returns 200 for `/`; the redirect happens in the
 * browser once React mounts. So the decision is a pure function and it is tested here.
 */
describe('shouldRedirectToLogin', () => {
  it.each(['/app', '/app/', '/app/inbox', '/app/settings/profile', '/app/properties/abc/widget'])(
    'redirects from %s - inside the application, a dead session strands you',
    (path) => {
      expect(shouldRedirectToLogin(path)).toBe(true);
    },
  );

  it.each([
    ['/', 'the marketing home - the page this broke'],
    ['/features', 'marketing'],
    ['/about', 'marketing'],
    ['/contact', 'marketing'],
    ['/terms', 'marketing'],
    ['/privacy', 'marketing'],
    ['/login', 'already there; redirecting would loop'],
    ['/register', 'signing up is not signing in'],
    ['/forgot-password', 'the whole point is that they cannot sign in'],
    ['/reset-password', 'reached from an email link with no session'],
    ['/accept-invitation', 'often a different person to whoever is signed in'],
    ['/verify-email', 'reached from an email link'],
    ['/help/prp_123/getting-started', 'a customer help centre, read by strangers'],
    ['/console', 'the operator console has its own identity entirely'],
    ['/console/login', 'and its own sign-in'],
  ])('stays put on %s (%s)', (path) => {
    expect(shouldRedirectToLogin(path)).toBe(false);
  });

  /**
   * `/application` and `/apples` start with the same four characters as `/app`. A `startsWith`
   * without the boundary would drag both into the protected set.
   */
  it.each(['/application', '/apps', '/apple', '/appointments'])(
    'does not mistake %s for the application',
    (path) => {
      expect(shouldRedirectToLogin(path)).toBe(false);
    },
  );
});
