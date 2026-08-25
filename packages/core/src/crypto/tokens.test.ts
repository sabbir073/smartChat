import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, safeEqual, tokenFingerprint } from './tokens.js';

describe('generateToken', () => {
  it('is url-safe so it survives links, headers and copy-paste', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('carries 256 bits by default', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 5000 }, () => generateToken())).size).toBe(5000);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('does not reveal the token', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('changes completely for a one-character difference', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    const shared = [...a].filter((char, index) => char === b[index]).length;
    expect(shared).toBeLessThan(20);
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects differing strings, including differing lengths', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('tokenFingerprint', () => {
  it('is short, stable and derived from the hash rather than the token', () => {
    const token = generateToken();
    expect(tokenFingerprint(token)).toHaveLength(8);
    expect(tokenFingerprint(token)).toBe(hashToken(token).slice(0, 8));
  });
});
