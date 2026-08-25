import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './encryption.js';

const KEY = 'a'.repeat(48);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces different ciphertext each time, so equal secrets are not detectable', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('is versioned so the format can change without guessing at existing rows', () => {
    expect(encryptSecret('x', KEY).startsWith('v1.')).toBe(true);
  });

  it('refuses a ciphertext encrypted with a different key', () => {
    const payload = encryptSecret('secret', KEY);
    expect(() => decryptSecret(payload, 'b'.repeat(48))).toThrow();
  });

  it('binds the ciphertext to its purpose', () => {
    const payload = encryptSecret('secret', KEY, 'totp');
    expect(decryptSecret(payload, KEY, 'totp')).toBe('secret');
    expect(() => decryptSecret(payload, KEY, 'other')).toThrow();
  });

  it('detects tampering rather than returning altered plaintext', () => {
    const parts = encryptSecret('secret', KEY).split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = (data[0] ?? 0) ^ 0xff;
    parts[3] = data.toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptSecret('garbage', KEY)).toThrow('Unrecognised ciphertext format');
    expect(() => decryptSecret('v2.a.b.c', KEY)).toThrow('Unrecognised ciphertext format');
  });
});
