import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'sc_session';

const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/accept-invitation',
];

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
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where they were going so sign-in can return them there.
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (hasSession && isPublic && pathname !== '/verify-email' && pathname !== '/reset-password') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
