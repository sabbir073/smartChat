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
