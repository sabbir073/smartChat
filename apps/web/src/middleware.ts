import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'sc_session';

/**
 * The signed-in application. Everything under here needs a session; nothing else does.
 *
 * Stated as one prefix rather than a list of pages, because the failure mode of a list is a page
 * somebody forgets to add to it - and that page is then readable by anybody.
 */
const APP_PREFIX = '/app';

/**
 * Everything else is public, and that is the whole rule.
 *
 * This used to be a list of public paths with the dashboard as the default. It is now the other
 * way round, because the two failure modes are not equally bad: forgetting to add a page to a
 * public list makes a marketing page ask for a login, which is annoying; forgetting to add one to
 * a *private* list exposes it, which is not. The marketing site, the help centre, the sign-in
 * pages and the operator console are all simply not under `/app`.
 */

/**
 * The dashboard's Content Security Policy.
 *
 * This is the second line of defence behind React's escaping: if a body of visitor-controlled text
 * ever did reach the DOM as markup, the policy is what stops it from becoming a script. It is
 * therefore built per request with a fresh nonce rather than declared statically - `unsafe-inline`
 * on script-src would make the whole header decorative.
 *
 * `strict-dynamic` means the allow-list is the nonce and nothing else: Next stamps the nonce onto
 * the script tags it renders (it reads it back out of the request header set below), those scripts
 * may load their own chunks, and no other source is trusted - not even 'self'. So an injected
 * `<script src="/anything.js">` is refused along with an injected inline one.
 *
 * The origins come from the environment at request time, not from the build, because the whole
 * point of the runtime-config design is that one image runs in every environment.
 */
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function httpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** A socket endpoint needs both spellings: the handshake is HTTP, the upgrade is ws. */
function socketOrigins(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    return [url.origin, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`];
  } catch {
    return [];
  }
}

function contentSecurityPolicy(nonce: string): string {
  const api = httpOrigin(process.env['API_URL']);
  const widget = httpOrigin(process.env['WIDGET_URL']);
  // Attachments are rendered straight from the object store over a short-lived signed URL, so the
  // store is a real image and fetch origin for this page.
  const storage = httpOrigin(process.env['S3_PUBLIC_ENDPOINT']);

  const connect = new Set(["'self'", ...socketOrigins(process.env['REALTIME_URL'])]);
  if (api) connect.add(api);
  if (storage) connect.add(storage);

  const image = new Set(["'self'", 'data:', 'blob:']);
  if (storage) image.add(storage);

  const frame = new Set(["'self'"]);
  if (widget) frame.add(widget);

  const script = IS_PRODUCTION
    ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
    : // `next dev` compiles with eval and injects its own un-nonced refresh scripts. Relaxing the
      // policy for the dev server is honest; pretending the strict one holds there would not be.
      ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // The one relaxation. Next inlines critical CSS and React writes style attributes at runtime;
    // neither carries a nonce and there is no supported way to give them one. A style cannot
    // execute, so this is a bounded concession rather than a hole in script-src.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...image].join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    `frame-src ${[...frame].join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(IS_PRODUCTION ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/**
 * A routing convenience, not a security control.
 *
 * The middleware only checks whether a session cookie is *present*, so an unauthenticated visitor
 * lands on the sign-in page instead of a dashboard that flashes and then empties. It cannot
 * validate the cookie, and it does not try: every piece of data is authorised by the API on every
 * request, which is where the real decision belongs.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // The rule, in one line: the application needs a session, and nothing else does. Inverting it
  // this way - rather than listing what is public - means a page added under /app tomorrow is
  // protected the moment it exists.
  const needsSession = pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`);

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  // Every response leaves through here, redirects included - a policy that only covers the happy
  // path is a policy an attacker routes around.
  const withCsp = <T extends NextResponse>(response: T): T => {
    response.headers.set('content-security-policy', csp);
    return response;
  };

  if (!hasSession && needsSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where they were going so sign-in can return them there.
    url.searchParams.set('next', pathname);
    return withCsp(NextResponse.redirect(url));
  }

  /**
   * Signing in already? Then the sign-in pages are pointless - send them to the application.
   *
   * The exclusions matter more than the rule. The marketing site and the help centre stay
   * readable while signed in; accepting an invitation must work for somebody already signed into a
   * *different* workspace, and bouncing them would silently drop the invitation; and the console
   * has its own identity entirely.
   */
  const bouncesWhenSignedIn =
    pathname === '/login' || pathname === '/register' || pathname === '/forgot-password';

  if (hasSession && bouncesWhenSignedIn) {
    const url = request.nextUrl.clone();
    url.pathname = APP_PREFIX;
    url.search = '';
    return withCsp(NextResponse.redirect(url));
  }

  // The policy goes out on the *request* as well. That is how Next finds the nonce: it parses the
  // header it is handed and stamps the value onto every script tag it renders, which is what makes
  // `strict-dynamic` survivable for a framework that emits its own bootstrap scripts.
  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('content-security-policy', csp);

  return withCsp(NextResponse.next({ request: { headers: forwarded } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
