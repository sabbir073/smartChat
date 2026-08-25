import type { z, ZodTypeAny } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Placeholder fragments shipped in `.env.example`. Refused outright in production. */
const PLACEHOLDER_MARKERS = ['change_me', 'changeme', 'your_secret_here', 'replace_me'];

const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|KEY|TOKEN)$/;

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
  const result = schema.safeParse(source);

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
      .map(([key]) => `${key}: still set to a development placeholder`);

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
