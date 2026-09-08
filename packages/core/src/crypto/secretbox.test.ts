import { describe, expect, it } from 'vitest';
import { SecretBox } from './secretbox.js';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('SecretBox', () => {
  it('round-trips', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('sk_test_51ABC');
    expect(sealed).not.toContain('sk_test');
    expect(box.open(sealed)).toBe('sk_test_51ABC');
  });

  it('seals the same secret differently each time', () => {
    const box = new SecretBox(KEY);
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  /** A backup opened with the wrong key must yield nothing, not something plausible. */
  it('refuses another key', () => {
    const sealed = new SecretBox(KEY).seal('secret');
    expect(() => new SecretBox(OTHER).open(sealed)).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = new SecretBox(KEY).seal('secret');
    const parts = sealed.split(':');
    const last = parts[3]!;
    parts[3] = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
    expect(() => new SecretBox(KEY).open(parts.join(':'))).toThrow();
  });

  it('refuses a value that is not sealed at all', () => {
    expect(() => new SecretBox(KEY).open('sk_test_plaintext')).toThrow(/not in a form/);
    expect(SecretBox.isSealed('sk_test_plaintext')).toBe(false);
    expect(SecretBox.isSealed(new SecretBox(KEY).seal('x'))).toBe(true);
  });

  it('insists on a real key', () => {
    expect(() => new SecretBox('short')).toThrow(/64 hex/);
    expect(() => new SecretBox('z'.repeat(64))).toThrow(/64 hex/);
  });

  it('handles an empty string and unicode', () => {
    const box = new SecretBox(KEY);
    expect(box.open(box.seal(''))).toBe('');
    expect(box.open(box.seal('🇧🇩 secret ✓'))).toBe('🇧🇩 secret ✓');
  });
});
