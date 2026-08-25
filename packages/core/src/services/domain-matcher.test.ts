import { describe, expect, it } from 'vitest';
import { hostFromOrigin, isOriginAllowed, matchesPattern } from './domain-matcher.js';

const exact = (pattern: string) => ({ pattern, isWildcard: false });
const wild = (pattern: string) => ({ pattern, isWildcard: true });

describe('hostFromOrigin', () => {
  it('extracts the host from a normal origin', () => {
    expect(hostFromOrigin('https://Example.com')).toBe('example.com');
    expect(hostFromOrigin('http://shop.example.com:8080')).toBe('shop.example.com');
  });

  it('rejects non-http schemes that could smuggle a match', () => {
    expect(hostFromOrigin('file:///etc/passwd')).toBeNull();
    expect(hostFromOrigin('javascript:alert(1)')).toBeNull();
    expect(hostFromOrigin('null')).toBeNull();
    expect(hostFromOrigin('')).toBeNull();
  });
});

describe('matchesPattern', () => {
  it('matches an exact host', () => {
    expect(matchesPattern('example.com', exact('example.com'))).toBe(true);
    expect(matchesPattern('shop.example.com', exact('example.com'))).toBe(false);
  });

  it('matches subdomains for a wildcard but not the apex', () => {
    expect(matchesPattern('app.example.com', wild('*.example.com'))).toBe(true);
    expect(matchesPattern('a.b.example.com', wild('*.example.com'))).toBe(true);
    expect(matchesPattern('example.com', wild('*.example.com'))).toBe(false);
  });

  it('does not match a lookalike domain that merely ends with the pattern', () => {
    expect(matchesPattern('notexample.com', wild('*.example.com'))).toBe(false);
    expect(matchesPattern('evil-example.com', exact('example.com'))).toBe(false);
    expect(matchesPattern('example.com.attacker.net', exact('example.com'))).toBe(false);
  });

  it('is insensitive to case and a trailing dot', () => {
    expect(matchesPattern('EXAMPLE.com.', exact('example.com'))).toBe(true);
  });
});

describe('isOriginAllowed', () => {
  const patterns = [exact('example.com'), wild('*.example.com')];

  it('allows a listed origin', () => {
    expect(isOriginAllowed('https://example.com', patterns)).toBe(true);
    expect(isOriginAllowed('https://shop.example.com', patterns)).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    expect(isOriginAllowed('https://attacker.test', patterns)).toBe(false);
  });

  it('rejects a missing origin rather than defaulting to allow', () => {
    expect(isOriginAllowed(undefined, patterns)).toBe(false);
  });

  it('allows localhost only when development mode asks for it', () => {
    expect(isOriginAllowed('http://localhost:3004', patterns)).toBe(false);
    expect(isOriginAllowed('http://localhost:3004', patterns, { allowLocalhost: true })).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3004', patterns, { allowLocalhost: true })).toBe(true);
  });
});
