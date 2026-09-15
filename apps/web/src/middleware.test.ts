import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './middleware';

/**
 * The policy is what decides whether a picture appears or a broken image does, so the origins it
 * names are worth a test. Profile pictures come from the API; attachments come from the store.
 */
describe('contentSecurityPolicy', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env['API_URL'] = 'https://api.example.com';
    process.env['REALTIME_URL'] = 'https://ws.example.com';
    process.env['WIDGET_URL'] = 'https://cdn.example.com';
    process.env['S3_PUBLIC_ENDPOINT'] = 'https://cdn.example.com/files';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  function directive(name: string): string {
    const found = contentSecurityPolicy('nonce-value')
      .split('; ')
      .find((part) => part.startsWith(`${name} `));
    return found ?? '';
  }

  it('lets the browser load profile pictures from the API', () => {
    expect(directive('img-src')).toContain('https://api.example.com');
  });

  it('still allows attachments from the object store, and data and blob URLs', () => {
    const img = directive('img-src');
    expect(img).toContain('https://cdn.example.com');
    expect(img).toContain('data:');
    expect(img).toContain('blob:');
  });

  it('does not open up script-src along the way', () => {
    expect(directive('script-src')).not.toContain('https://api.example.com');
  });

  it('allows the API and the socket as fetch destinations', () => {
    const connect = directive('connect-src');
    expect(connect).toContain('https://api.example.com');
    expect(connect).toContain('wss://ws.example.com');
  });

  it('survives an environment with nothing configured', () => {
    delete process.env['API_URL'];
    delete process.env['S3_PUBLIC_ENDPOINT'];
    expect(directive('img-src')).toBe("img-src 'self' data: blob:");
  });
});
