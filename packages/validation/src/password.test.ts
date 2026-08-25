import { describe, expect, it } from 'vitest';
import { passwordIsDerivedFrom, passwordSchema } from './password.js';

const ok = (value: string) => passwordSchema.safeParse(value).success;
const reason = (value: string) => passwordSchema.safeParse(value);

describe('passwordSchema', () => {
  it('accepts a reasonable passphrase without demanding symbol soup', () => {
    expect(ok('correct horse battery staple')).toBe(true);
    expect(ok('Tuesday-Mango-Ferry')).toBe(true);
  });

  it('rejects anything shorter than the minimum', () => {
    expect(ok('Sh0rt!1')).toBe(false);
  });

  it('rejects the passwords attackers try first', () => {
    expect(ok('password123')).toBe(false);
    expect(ok('Password123')).toBe(false);
    expect(ok('welcome123')).toBe(false);
  });

  it('rejects long keyboard runs', () => {
    expect(ok('abcdefghijkl')).toBe(false);
    expect(ok('987654321000')).toBe(false);
  });

  it('rejects a single repeated character', () => {
    expect(ok('aaaaaaaaaaaa')).toBe(false);
  });

  it('explains why, rather than failing silently', () => {
    const result = reason('password123');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/too common/i);
    }
  });
});

describe('passwordIsDerivedFrom', () => {
  it('catches a password built from the email local part', () => {
    expect(passwordIsDerivedFrom('mahedi-is-great-1', 'mahedi@example.com')).toBe(true);
  });

  it('catches a password built from the company name, ignoring punctuation', () => {
    expect(passwordIsDerivedFrom('AbcDigital!2026', 'owner@x.com', 'Owner', 'ABC Digital')).toBe(
      true,
    );
  });

  it('does not flag an unrelated password', () => {
    expect(passwordIsDerivedFrom('Tuesday-Mango-Ferry', 'mahedi@example.com', 'Mahedi')).toBe(
      false,
    );
  });

  it('ignores fragments too short to be meaningful', () => {
    expect(passwordIsDerivedFrom('a-strong-passphrase', 'ab@example.com')).toBe(false);
  });
});
