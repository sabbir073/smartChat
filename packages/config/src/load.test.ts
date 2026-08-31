import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from './load.js';
import { baseEnvSchema, httpEnvSchema, secretsEnvSchema } from './schemas.js';

const LONG = 'a'.repeat(40);

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
    try {
      loadConfig(secretsEnvSchema, { SESSION_SECRET: 'short' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(4);
      expect(issues.some((i) => i.startsWith('SESSION_SECRET'))).toBe(true);
      expect(issues.some((i) => i.startsWith('JWT_SECRET'))).toBe(true);
    }
  });

  it('refuses to boot in production with a placeholder secret', () => {
    const schema = baseEnvSchema.merge(secretsEnvSchema);
    const env = {
      NODE_ENV: 'production',
      SESSION_SECRET: `dev_session_secret_change_me_${'0'.repeat(20)}`,
      JWT_SECRET: LONG,
      VISITOR_TOKEN_SECRET: LONG,
      ENCRYPTION_KEY: LONG,
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(schema, env)).toThrow(ConfigError);
  });

  it('allows the same placeholder in development', () => {
    const schema = baseEnvSchema.merge(secretsEnvSchema);
    const env = {
      NODE_ENV: 'development',
      SESSION_SECRET: `dev_session_secret_change_me_${'0'.repeat(20)}`,
      JWT_SECRET: LONG,
      VISITOR_TOKEN_SECRET: LONG,
      ENCRYPTION_KEY: LONG,
    } as unknown as NodeJS.ProcessEnv;

    expect(loadConfig(schema, env).JWT_SECRET).toBe(LONG);
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
