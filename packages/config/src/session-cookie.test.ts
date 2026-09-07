import { describe, expect, it } from 'vitest';
import { ConfigError, cookieDomainCovers, loadConfig, sessionCookieIssues } from './load.js';
import { baseEnvSchema, httpEnvSchema, urlsEnvSchema } from './schemas.js';

const schema = baseEnvSchema.merge(urlsEnvSchema).merge(httpEnvSchema);

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    APP_URL: 'https://getchat.site',
    API_URL: 'https://api.getchat.site',
    REALTIME_URL: 'https://ws.getchat.site',
    WIDGET_URL: 'https://cdn.getchat.site',
    TRUST_PROXY: 'true',
    COOKIE_SECURE: 'true',
    ALLOW_LOCALHOST_ORIGINS: 'false',
    ALLOW_PRIVATE_WEBHOOK_URLS: 'false',
    AUTO_VERIFY_EMAIL: 'false',
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe('cookieDomainCovers', () => {
  it.each([
    ['getchat.site', 'getchat.site'],
    ['.getchat.site', 'getchat.site'],
    ['.getchat.site', 'api.getchat.site'],
    ['getchat.site', 'api.getchat.site'],
    ['GetChat.Site', 'API.getchat.site'],
    ['.getchat.site', 'a.b.getchat.site'],
  ])('%s covers %s', (domain, host) => {
    expect(cookieDomainCovers(domain, host)).toBe(true);
  });

  /**
   * The suffix has to fall on a label boundary. `chat.site` must not be treated as covering
   * `getchat.site`, or the check would wave through a domain the browser will reject.
   */
  it.each([
    ['chat.site', 'getchat.site'],
    ['api.getchat.site', 'getchat.site'],
    ['getchat.site', 'getchat.site.evil.com'],
    ['other.site', 'getchat.site'],
    ['', 'getchat.site'],
    ['getchat.site', ''],
  ])('%s does not cover %s', (domain, host) => {
    expect(cookieDomainCovers(domain, host)).toBe(false);
  });
});

/**
 * The bug this pins, in full.
 *
 * With the dashboard on `getchat.site` and the API on `api.getchat.site` and no `COOKIE_DOMAIN`,
 * the session cookie is host-only to the API. Sign-in returns 200 and the browser stores it, so
 * nothing anywhere reports a failure — but the dashboard's middleware never sees `sc_session` and
 * redirects every successful sign-in straight back to the sign-in page, and `document.cookie` on
 * the dashboard cannot read the CSRF token either, so every mutation goes out without the header.
 * A spinner that never stops, and not one log line.
 */
describe('sessionCookieIssues', () => {
  it('accepts a domain that covers both hosts', () => {
    expect(
      sessionCookieIssues('https://getchat.site', 'https://api.getchat.site', '.getchat.site'),
    ).toEqual([]);
  });

  it('refuses different hosts with no cookie domain', () => {
    const issues = sessionCookieIssues(
      'https://getchat.site',
      'https://api.getchat.site',
      undefined,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('COOKIE_DOMAIN');
    expect(issues[0]).toContain('api.getchat.site');
  });

  it('refuses a cookie domain that covers only one of the two', () => {
    const issues = sessionCookieIssues(
      'https://getchat.site',
      'https://api.getchat.site',
      'api.getchat.site',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('getchat.site');
  });

  it('suggests a domain that would work', () => {
    const issues = sessionCookieIssues(
      'https://getchat.site',
      'https://api.getchat.site',
      undefined,
    );
    expect(issues[0]).toContain('COOKIE_DOMAIN');
  });

  it('needs no cookie domain when both are the same host', () => {
    expect(
      sessionCookieIssues('https://app.example.com', 'https://app.example.com/api', undefined),
    ).toEqual([]);
  });

  it('still refuses a cookie domain the single host is not under', () => {
    expect(
      sessionCookieIssues('https://app.example.com', 'https://app.example.com', 'other.test'),
    ).toHaveLength(1);
  });

  it('says nothing about URLs it cannot parse - the schema already refused those', () => {
    expect(sessionCookieIssues('not a url', 'https://api.getchat.site', undefined)).toEqual([]);
  });
});

describe('loadConfig, production', () => {
  it('refuses to start a deployment whose sign-in could never work', () => {
    expect(() => loadConfig(schema, env({}))).toThrow(ConfigError);
  });

  it('starts once the cookie domain spans both hosts', () => {
    const cfg = loadConfig(schema, env({ COOKIE_DOMAIN: '.getchat.site' }));
    expect(cfg.COOKIE_DOMAIN).toBe('.getchat.site');
  });

  /**
   * The worker and the realtime service carry the same URLs and set no cookies at all. Demanding
   * a cookie domain of them would stop two services over a setting neither one reads.
   */
  it('leaves a process that sets no cookies alone', () => {
    const withoutCookies = baseEnvSchema.merge(urlsEnvSchema);
    expect(() =>
      loadConfig(withoutCookies, {
        NODE_ENV: 'production',
        APP_URL: 'https://getchat.site',
        API_URL: 'https://api.getchat.site',
        REALTIME_URL: 'https://ws.getchat.site',
        WIDGET_URL: 'https://cdn.getchat.site',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('leaves development alone, where both halves are usually on localhost', () => {
    expect(() =>
      loadConfig(schema, {
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:3000',
        API_URL: 'http://localhost:3001',
        REALTIME_URL: 'http://localhost:3002',
        WIDGET_URL: 'http://localhost:3003',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
