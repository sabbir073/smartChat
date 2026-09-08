import { describe, expect, it } from 'vitest';
import { ConfigError, isLocalRelayHost, loadConfig } from './load.js';
import { baseEnvSchema, mailEnvSchema, secretsEnvSchema } from './schemas.js';

const schema = baseEnvSchema.merge(mailEnvSchema);

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    MAIL_FROM_ADDRESS: 'no-reply@example.com',
    ...extra,
  } as NodeJS.ProcessEnv;
}

/**
 * The bug these pin.
 *
 * A local Postfix offers STARTTLS with a self-signed certificate. Nodemailer upgrades
 * opportunistically even on port 25, verifies, fails with "self-signed certificate" at CONN, and
 * every email job burns its five attempts and dies — so registration succeeds and no verification
 * email is ever sent. The escape hatch has to exist. It also has to be impossible to point at a
 * relay on the internet, because there it would hand every password-reset link to anything on the
 * path.
 */
describe('isLocalRelayHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'host.docker.internal',
    'gateway.docker.internal',
    'mail.internal',
    'postfix.local',
    '127.0.0.1',
    '127.13.2.9',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.169.254',
    '::1',
    '[::1]',
    'fd00::1',
    'fe80::1',
  ])('accepts %s as a relay nobody else can stand in front of', (host) => {
    expect(isLocalRelayHost(host)).toBe(true);
  });

  it.each([
    'smtp.sendgrid.net',
    'email-smtp.us-east-1.amazonaws.com',
    'smtp.gmail.com',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '11.0.0.1',
    '192.169.1.1',
    '2001:4860:4860::8888',
    '',
    '   ',
    'localhost.evil.com',
    '999.999.999.999',
  ])('treats %s as public', (host) => {
    expect(isLocalRelayHost(host)).toBe(false);
  });
});

describe('SMTP_TLS_REJECT_UNAUTHORIZED in production', () => {
  it('defaults to verifying the certificate', () => {
    const cfg = loadConfig(schema, env({ SMTP_HOST: 'smtp.sendgrid.net' }));
    expect(cfg.SMTP_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });

  it('allows verification to be waived for a relay on this host', () => {
    const cfg = loadConfig(
      schema,
      env({ SMTP_HOST: 'host.docker.internal', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' }),
    );
    expect(cfg.SMTP_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('refuses to start when verification is waived for a public relay', () => {
    expect(() =>
      loadConfig(
        schema,
        env({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses to start when verification is waived with no relay named at all', () => {
    expect(() => loadConfig(schema, env({ SMTP_TLS_REJECT_UNAUTHORIZED: 'false' }))).toThrow(
      ConfigError,
    );
  });

  it('names the offending host in the error, so the fix is obvious', () => {
    try {
      loadConfig(
        schema,
        env({ SMTP_HOST: 'smtp.gmail.com', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('smtp.gmail.com');
      expect((error as ConfigError).message).toContain('SMTP_TLS_REJECT_UNAUTHORIZED');
    }
  });

  it('leaves development alone - mailpit and a local Postfix both need to just work', () => {
    const cfg = loadConfig(schema, {
      NODE_ENV: 'development',
      MAIL_FROM_ADDRESS: 'no-reply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_TLS_REJECT_UNAUTHORIZED: 'false',
    } as NodeJS.ProcessEnv);
    expect(cfg.SMTP_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });
});

describe('SETTINGS_ENCRYPTION_KEY in production', () => {
  const withKey = (key: string) =>
    loadConfig(baseEnvSchema.merge(secretsEnvSchema), {
      NODE_ENV: 'production',
      VISITOR_TOKEN_SECRET: 'x'.repeat(40),
      SETTINGS_ENCRYPTION_KEY: key,
    } as NodeJS.ProcessEnv);

  it('refuses the all-zeros key the example file ships', () => {
    expect(() => withKey('0'.repeat(64))).toThrow(ConfigError);
  });

  it('refuses anything that is not 64 hex characters', () => {
    expect(() => withKey('not-hex')).toThrow(ConfigError);
    expect(() => withKey('a'.repeat(63))).toThrow(ConfigError);
  });

  it('accepts a real key', () => {
    expect(withKey('0123456789abcdef'.repeat(4)).SETTINGS_ENCRYPTION_KEY).toBe(
      '0123456789abcdef'.repeat(4),
    );
  });
});
