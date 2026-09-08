import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from './load.js';
import { baseEnvSchema, httpEnvSchema, secretsEnvSchema } from './schemas.js';

const LONG = 'a'.repeat(40);

/**
 * The environment's own boolean, not `z.coerce.boolean()`.
 *
 * Everything arrives from the process environment as a string, and `z.coerce.boolean('false')` is
 * `true` - every non-empty string is. Using it here would have made these tests assert the
 * opposite of what they read as, which is worse than not having them.
 */
const envBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const cfg = loadConfig(baseEnvSchema, {} as NodeJS.ProcessEnv);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  /**
   * The bug this pins: `docker compose` writes an empty string for a variable nobody set, and an
   * empty string is a *present* value to zod - so an optional field with a length rule refused to
   * start the service over a setting that was meant to be optional. `/metrics` is exactly that
   * field, and the API would not boot with the shipped defaults.
   */
  it('treats an empty environment variable as unset, the way a compose default means it', () => {
    const schema = z.object({
      METRICS_TOKEN: z.string().min(16).optional(),
      COOKIE_DOMAIN: z.string().optional(),
      LOG_LEVEL: z.string().default('info'),
    });

    const cfg = loadConfig(schema, {
      METRICS_TOKEN: '',
      COOKIE_DOMAIN: '',
      LOG_LEVEL: '',
    } as NodeJS.ProcessEnv);

    expect(cfg.METRICS_TOKEN).toBeUndefined();
    expect(cfg.COOKIE_DOMAIN).toBeUndefined();
    // And a default applies rather than being shadowed by the empty string.
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('still reads a value that was actually provided', () => {
    const schema = z.object({ METRICS_TOKEN: z.string().min(16).optional() });
    const cfg = loadConfig(schema, { METRICS_TOKEN: LONG } as NodeJS.ProcessEnv);
    expect(cfg.METRICS_TOKEN).toBe(LONG);
  });

  it('reports every problem at once rather than one per restart', () => {
    const schema = secretsEnvSchema.merge(
      z.object({ EXTRA_SECRET: z.string().min(32), OTHER_SECRET: z.string().min(32) }),
    );
    try {
      loadConfig(schema, { VISITOR_TOKEN_SECRET: 'short' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues.some((i) => i.startsWith('VISITOR_TOKEN_SECRET'))).toBe(true);
      expect(issues.some((i) => i.startsWith('EXTRA_SECRET'))).toBe(true);
    }
  });

  /**
   * The guard for ADR-092: a required secret must be one somebody can rotate to some effect.
   *
   * `SESSION_SECRET`, `JWT_SECRET` and `ENCRYPTION_KEY` were all mandatory here and read by
   * nothing, which made rotating them a placebo. If one comes back, it has to come back with a
   * reader.
   */
  it('demands only secrets the product actually reads', () => {
    const keys = Object.keys(secretsEnvSchema.shape);
    expect(keys).toContain('VISITOR_TOKEN_SECRET');
    expect(keys).not.toContain('SESSION_SECRET');
    expect(keys).not.toContain('JWT_SECRET');
    expect(keys).not.toContain('ENCRYPTION_KEY');
  });

  it('refuses to boot in production with a placeholder secret', () => {
    const schema = baseEnvSchema.merge(secretsEnvSchema);
    const env = {
      NODE_ENV: 'production',
      VISITOR_TOKEN_SECRET: `dev_visitor_token_secret_change_me_${'0'.repeat(20)}`,
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(schema, env)).toThrow(ConfigError);
  });

  it('allows the same placeholder in development', () => {
    const schema = baseEnvSchema.merge(secretsEnvSchema);
    const env = {
      NODE_ENV: 'development',
      VISITOR_TOKEN_SECRET: `dev_visitor_token_secret_change_me_${'0'.repeat(20)}`,
      SETTINGS_ENCRYPTION_KEY: '0'.repeat(64),
    } as unknown as NodeJS.ProcessEnv;

    expect(loadConfig(schema, env).VISITOR_TOKEN_SECRET).toContain('change_me');
  });

  /**
   * The hole this pins open.
   *
   * The placeholder check matched four "you were meant to edit this" markers, and none of the
   * credentials `.env.example` actually ships contains any of them. A production server started
   * from an unedited file therefore booted happily on the published Postgres password - the one
   * in a public repository. The password is inside a connection string, so the key-name rule that
   * catches `*_PASSWORD` never looked at it either.
   */
  it('refuses a production database URL that still carries the shipped dev password', () => {
    const schema = baseEnvSchema.merge(
      z.object({ DATABASE_URL: z.string(), REDIS_URL: z.string().optional() }),
    );
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://smartchat:smartchat_dev_password@postgres:5432/smartchat',
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(schema, env)).toThrow(ConfigError);
  });

  it('accepts a production database URL with a real password', () => {
    const schema = baseEnvSchema.merge(z.object({ DATABASE_URL: z.string() }));
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://smartchat:${LONG}@db.internal:5432/smartchat`,
    } as unknown as NodeJS.ProcessEnv;

    expect(loadConfig(schema, env).DATABASE_URL).toContain('db.internal');
  });

  it('refuses the shipped dev object-storage and redis secrets in production', () => {
    const schema = baseEnvSchema.merge(
      z.object({ S3_SECRET_KEY: z.string(), REDIS_PASSWORD: z.string() }),
    );
    const env = {
      NODE_ENV: 'production',
      S3_SECRET_KEY: 'smartchat_dev_secret',
      REDIS_PASSWORD: 'smartchat_dev_redis',
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(schema, env)).toThrow(ConfigError);
  });

  /**
   * Each of these fails silently rather than loudly, which is what makes refusing to start the
   * right response: a session cookie sent over plain HTTP and a rate limiter bucketing the whole
   * internet under the proxy's address both look completely normal until they matter.
   */
  it.each([
    ['COOKIE_SECURE', false],
    ['TRUST_PROXY', false],
    ['ALLOW_LOCALHOST_ORIGINS', true],
    ['AUTO_VERIFY_EMAIL', true],
  ] as const)('refuses to boot in production with %s = %s', (key, wrong) => {
    const schema = baseEnvSchema.merge(
      z.object({
        COOKIE_SECURE: envBool,
        TRUST_PROXY: envBool,
        ALLOW_LOCALHOST_ORIGINS: envBool,
        AUTO_VERIFY_EMAIL: envBool,
      }),
    );
    const env = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'true',
      ALLOW_LOCALHOST_ORIGINS: 'false',
      AUTO_VERIFY_EMAIL: 'false',
      [key]: String(wrong),
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(schema, env)).toThrow(ConfigError);
  });

  it('boots in production when all of them are right', () => {
    const schema = baseEnvSchema.merge(
      z.object({
        COOKIE_SECURE: envBool,
        TRUST_PROXY: envBool,
        ALLOW_LOCALHOST_ORIGINS: envBool,
        AUTO_VERIFY_EMAIL: envBool,
      }),
    );
    const env = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'true',
      ALLOW_LOCALHOST_ORIGINS: 'false',
      AUTO_VERIFY_EMAIL: 'false',
    } as unknown as NodeJS.ProcessEnv;

    expect(loadConfig(schema, env).COOKIE_SECURE).toBe(true);
  });

  it('leaves development alone - none of the above applies there', () => {
    const schema = baseEnvSchema.merge(
      z.object({ DATABASE_URL: z.string(), COOKIE_SECURE: envBool }),
    );
    const env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://smartchat:smartchat_dev_password@postgres:5432/smartchat',
      COOKIE_SECURE: 'false',
    } as unknown as NodeJS.ProcessEnv;

    expect(loadConfig(schema, env).COOKIE_SECURE).toBe(false);
  });

  it('coerces and bounds numeric and boolean values', () => {
    const cfg = loadConfig(httpEnvSchema, {
      PORT: '3005',
      TRUST_PROXY: 'true',
      CORS_DASHBOARD_ORIGINS: 'http://a.test, http://b.test ,',
    } as unknown as NodeJS.ProcessEnv);

    expect(cfg.PORT).toBe(3005);
    expect(cfg.TRUST_PROXY).toBe(true);
    expect(cfg.CORS_DASHBOARD_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects a port outside the valid range', () => {
    expect(() =>
      loadConfig(z.object({ PORT: httpEnvSchema.shape.PORT }), {
        PORT: '99999',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });
});
