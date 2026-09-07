import type { z, ZodTypeAny } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Values from `.env.example` that must never reach production.
 *
 * The first four are the "you were meant to edit this" markers. The rest are the *actual dev
 * credentials this repository ships* - `smartchat_dev_password` for Postgres,
 * `smartchat_dev_redis`, `smartchat_dev_secret` for object storage. None of them contains the
 * word "change", so the marker list alone waved all three through: a server started from an
 * unedited `.env` would have run production on the published database password. The check is only
 * worth anything if it refuses the values somebody would actually still have set.
 */
const PLACEHOLDER_MARKERS = [
  'change_me',
  'changeme',
  'your_secret_here',
  'replace_me',
  'smartchat_dev',
  'dev_visitor_secret',
  'dev_password',
];

const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|KEY|TOKEN)$/;

/**
 * An environment variable set to the empty string is not set.
 *
 * This is what a compose default means. `METRICS_TOKEN: ${METRICS_TOKEN:-}` puts an empty string
 * into the container when nobody has chosen a value, and to zod an empty string is a present
 * value: an optional field that also has a `min(16)` then fails, and the service refuses to start
 * over a setting that is meant to be optional. That is exactly what happened to `/metrics` - the
 * one field where "absent" and "empty" had to mean the same thing was the one where they did not.
 *
 * Stripping them here rather than patching each schema means every field gets the behaviour, and
 * a `.default()` applies where one exists instead of being shadowed by an empty string.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === '') continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Is this SMTP host something only reachable from inside this machine or its private network?
 *
 * Used by the production check on `SMTP_TLS_REJECT_UNAUTHORIZED`. Turning certificate
 * verification off is a reasonable answer for a relay on the same host and an unreasonable one
 * for a relay on the internet, and the difference is exactly this predicate. Anything it does not
 * recognise counts as public, which is the safe way round: a name it has never seen is treated as
 * something a stranger could be sitting in front of.
 */
export function isLocalRelayHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (value === '') return false;

  if (
    value === 'localhost' ||
    value === 'host.docker.internal' ||
    value === 'gateway.docker.internal' ||
    value === '::1' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    value.endsWith('.internal')
  ) {
    return true;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)) return true;

  return false;
}

/**
 * Would a cookie set with `domain` be sent to `host`?
 *
 * The browser's rule, and only it: an exact match, or a suffix match on a label boundary. A
 * leading dot is legacy syntax that means the same thing as no dot, so it is stripped first.
 */
export function cookieDomainCovers(domain: string, host: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\./, '');
  const h = host.trim().toLowerCase();
  if (d === '' || h === '') return false;
  return h === d || h.endsWith(`.${d}`);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Can the session cookie the API sets be seen by the dashboard?
 *
 * This looks like a detail and is not. When the dashboard and the API are on different hosts —
 * `getchat.site` and `api.getchat.site`, the arrangement this product is designed for — a cookie
 * set without a `Domain` is host-only to the API. The API then works perfectly on its own: sign
 * in returns 200, the browser stores the cookie, and every request back to the API carries it.
 *
 * What breaks is everything on the *dashboard's* origin. Its middleware reads `sc_session` to
 * decide whether somebody may see `/app`, and never receives it — so a successful sign-in is
 * redirected straight back to the sign-in page, with no error anywhere, because nothing failed.
 * The CSRF token is the same story: it is set on the API's host, `document.cookie` on the
 * dashboard cannot read it, and every state-changing request goes out without the header.
 *
 * None of that produces a log line. So it is checked here, at boot, where it can produce one.
 */
export function sessionCookieIssues(
  appUrl: string,
  apiUrl: string,
  cookieDomain: string | undefined,
): string[] {
  const app = hostOf(appUrl);
  const api = hostOf(apiUrl);
  if (!app || !api) return [];

  // One host: a host-only cookie reaches everything, and a domain is unnecessary.
  if (app === api) {
    if (cookieDomain && !cookieDomainCovers(cookieDomain, app)) {
      return [
        `COOKIE_DOMAIN: "${cookieDomain}" does not cover ${app}, so the browser will reject the session cookie outright`,
      ];
    }
    return [];
  }

  if (!cookieDomain) {
    return [
      `COOKIE_DOMAIN: required when APP_URL (${app}) and API_URL (${api}) are different hosts - without it the session cookie is host-only to ${api}, the dashboard never sees it, and signing in silently returns to the sign-in page`,
    ];
  }

  const uncovered = [app, api].filter((host) => !cookieDomainCovers(cookieDomain, host));
  if (uncovered.length > 0) {
    return [
      `COOKIE_DOMAIN: "${cookieDomain}" does not cover ${uncovered.join(' or ')} - it must be a parent of both APP_URL (${app}) and API_URL (${api}), for example ".${app.split('.').slice(-2).join('.')}"`,
    ];
  }

  return [];
}

/**
 * Parse and validate the environment for one process.
 *
 * Throws `ConfigError` with every problem listed at once, rather than failing on the first one —
 * fixing configuration one error per restart is miserable.
 */
export function loadConfig<T extends ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(withoutEmptyValues(source));

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const parsed = result.data as Record<string, unknown>;

  if (parsed['NODE_ENV'] === 'production') {
    const offenders = Object.entries(parsed)
      .filter(([key, value]) => {
        if (typeof value !== 'string' || !SECRET_KEY_PATTERN.test(key)) return false;
        const lowered = value.toLowerCase();
        return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
      })
      .map(([key]) => `${key}: still set to a development value from .env.example`);

    // A connection string carries its password inline, so the key-name rule above never sees it.
    for (const key of ['DATABASE_URL', 'REDIS_URL']) {
      const value = parsed[key];
      if (typeof value !== 'string') continue;
      const lowered = value.toLowerCase();
      if (PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker))) {
        offenders.push(`${key}: still carries a development password from .env.example`);
      }
    }

    /**
     * Settings that are safe to get wrong in development and not safe to get wrong here.
     *
     * These are all set correctly by `docker-compose.prod.yml`, which is exactly why they are
     * checked: the overlay is a file somebody can forget to pass. Refusing to start is the only
     * way the guarantee survives being run a different way, and each of these fails *silently* -
     * a session cookie sent over plain HTTP, or a rate limiter that buckets the whole internet
     * under the proxy's address, both look completely normal until they matter.
     */
    const mustBe: [string, boolean, string][] = [
      ['COOKIE_SECURE', true, 'session cookies would be sent over plain HTTP'],
      [
        'TRUST_PROXY',
        true,
        'every per-IP limit would key on the proxy and apply to everyone at once',
      ],
      ['ALLOW_LOCALHOST_ORIGINS', false, 'any local page could open a widget session'],
      ['ALLOW_PRIVATE_WEBHOOK_URLS', false, 'a webhook could be aimed at your own private network'],
      ['AUTO_VERIFY_EMAIL', false, 'anybody could sign up as anybody'],
    ];

    for (const [key, required, consequence] of mustBe) {
      if (!(key in parsed)) continue;
      if (parsed[key] !== required) {
        offenders.push(`${key}: must be ${required} in production - otherwise ${consequence}`);
      }
    }

    /**
     * Certificate verification may only be waived for a relay nobody else can stand in front of.
     *
     * Without this, `SMTP_TLS_REJECT_UNAUTHORIZED=false` - the line an operator copies from a
     * forum post the first time a local Postfix refuses to talk - would silently downgrade a
     * public relay too, and every verification link and password reset this product sends would
     * be readable by anything on the path.
     */
    if (
      'SMTP_TLS_REJECT_UNAUTHORIZED' in parsed &&
      parsed['SMTP_TLS_REJECT_UNAUTHORIZED'] === false
    ) {
      const host = parsed['SMTP_HOST'];
      if (typeof host !== 'string' || !isLocalRelayHost(host)) {
        offenders.push(
          `SMTP_TLS_REJECT_UNAUTHORIZED: may only be false when SMTP_HOST is a local or private relay (got ${
            typeof host === 'string' && host !== '' ? host : 'no SMTP_HOST'
          }) - otherwise anything on the path can read every verification link this product sends`,
        );
      }
    }

    /**
     * Only for a process that actually sets cookies.
     *
     * `COOKIE_SECURE` has a default, so it is present exactly when the schema includes the cookie
     * section — which is the API and nothing else. The worker and the realtime service both carry
     * `APP_URL` and `API_URL` and set no cookies at all, and demanding a cookie domain of them
     * would stop two services over a setting neither one reads.
     */
    if (
      'COOKIE_SECURE' in parsed &&
      typeof parsed['APP_URL'] === 'string' &&
      typeof parsed['API_URL'] === 'string'
    ) {
      offenders.push(
        ...sessionCookieIssues(
          parsed['APP_URL'],
          parsed['API_URL'],
          typeof parsed['COOKIE_DOMAIN'] === 'string' ? parsed['COOKIE_DOMAIN'] : undefined,
        ),
      );
    }

    if (offenders.length > 0) throw new ConfigError(offenders);
  }

  return result.data;
}

/**
 * Load config and exit the process on failure.
 *
 * Used at the top of every entrypoint: a misconfigured service must never reach the point where it
 * accepts traffic.
 */
export function loadConfigOrExit<T extends ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  try {
    return loadConfig(schema, source);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Deliberate: the logger is not configured yet, and this must be visible in container logs.
      console.error(`\n[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export const isProduction = (env: { NODE_ENV: string }) => env.NODE_ENV === 'production';
export const isDevelopment = (env: { NODE_ENV: string }) => env.NODE_ENV === 'development';
export const isTest = (env: { NODE_ENV: string }) => env.NODE_ENV === 'test';
