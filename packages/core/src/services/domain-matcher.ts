/**
 * Origin validation for the widget surface.
 *
 * The `Origin` header is attacker-controllable, so this is never used for authorisation on its
 * own — it decides whether a *property* has authorised a site to embed its widget, which is a
 * different question from "who is this visitor".
 */
export interface DomainPattern {
  pattern: string;
  isWildcard: boolean;
}

export function hostFromOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * Match a host against one allowed pattern.
 *
 * `*.example.com` matches `app.example.com` and `a.b.example.com`, but **not** bare `example.com`
 * — a wildcard entry authorises subdomains, and the apex has to be listed if it is wanted. It
 * also never matches a host that merely ends with the string, so `notexample.com` is rejected.
 */
export function matchesPattern(host: string, pattern: DomainPattern): boolean {
  const normalisedHost = host.toLowerCase().replace(/\.$/, '');
  const normalisedPattern = pattern.pattern.toLowerCase().replace(/\.$/, '');

  if (!normalisedPattern.startsWith('*.')) {
    return normalisedHost === normalisedPattern;
  }

  const suffix = normalisedPattern.slice(1); // ".example.com"
  return normalisedHost.endsWith(suffix) && normalisedHost.length > suffix.length;
}

export function isOriginAllowed(
  origin: string | undefined,
  patterns: DomainPattern[],
  options: { allowLocalhost?: boolean } = {},
): boolean {
  if (!origin) return false;
  const host = hostFromOrigin(origin);
  if (!host) return false;
  if (options.allowLocalhost && isLocalHost(host)) return true;
  return patterns.some((pattern) => matchesPattern(host, pattern));
}
