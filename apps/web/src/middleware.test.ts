import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, mediaOrigins } from './middleware';

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

  /**
   * A call's audio goes straight from the browser to the media server, so the policy has to name
   * it - in both spellings, because the client signals over a WebSocket and validates a refused
   * connection with a plain HTTPS request to the same host.
   */
  it('lets the browser reach the media server for a call', () => {
    process.env['LIVEKIT_PUBLIC_URL'] = 'wss://lk.example.com';
    const connect = directive('connect-src');
    expect(connect).toContain('wss://lk.example.com');
    expect(connect).toContain('https://lk.example.com');
    expect(directive('script-src')).not.toContain('lk.example.com');
  });

  it('accepts the NEXT_PUBLIC_ spelling of the media server address', () => {
    delete process.env['LIVEKIT_PUBLIC_URL'];
    process.env['NEXT_PUBLIC_LIVEKIT_URL'] = 'wss://media.example.com';
    expect(directive('connect-src')).toContain('wss://media.example.com');
  });

  it('names no media server when calling is not configured', () => {
    delete process.env['LIVEKIT_PUBLIC_URL'];
    delete process.env['NEXT_PUBLIC_LIVEKIT_URL'];
    expect(directive('connect-src')).not.toContain('wss://lk');
  });
});

describe('mediaOrigins', () => {
  it('yields the socket and the HTTP spelling whichever one was configured', () => {
    expect(mediaOrigins('wss://lk.example.com')).toEqual([
      'wss://lk.example.com',
      'https://lk.example.com',
    ]);
    expect(mediaOrigins('https://lk.example.com/')).toEqual([
      'wss://lk.example.com',
      'https://lk.example.com',
    ]);
    expect(mediaOrigins('ws://localhost:7880')).toEqual([
      'ws://localhost:7880',
      'http://localhost:7880',
    ]);
  });

  it('ignores nothing and nonsense', () => {
    expect(mediaOrigins(undefined)).toEqual([]);
    expect(mediaOrigins('not a url')).toEqual([]);
  });
});
