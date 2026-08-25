import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  fakePasswordVerification,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

describe('password hashing', () => {
  it('produces argon2id hashes with the configured parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
  });

  it('salts, so the same password never produces the same hash twice', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Tuesday-Mango-Ferry');
    await expect(verifyPassword(hash, 'Tuesday-Mango-Ferry')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Tuesday-Mango-Ferr')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('treats a corrupted hash as a wrong password rather than throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });

  it('does not ask for a rehash when the parameters already match', async () => {
    expect(needsRehash(await hashPassword('a-good-passphrase'))).toBe(false);
  });

  it('asks for a rehash when a stored hash used weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('spends comparable time on an unknown account', async () => {
    const start = Date.now();
    await fakePasswordVerification();
    const fake = Date.now() - start;

    const realStart = Date.now();
    await hashPassword('anything-at-all');
    const real = Date.now() - realStart;

    // Same order of magnitude is what defeats timing-based account enumeration.
    expect(fake).toBeGreaterThan(real / 10);
  });
});
