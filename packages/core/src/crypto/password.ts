import { hash, verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` from @node-rs/argon2 is an ambient `const enum`, which cannot be referenced
 * under `isolatedModules`. Its value is pinned here instead, with the assertion below keeping the
 * `password.test.ts` asserts that the produced hashes really are argon2id, so a change to the
 * upstream definition cannot pass unnoticed.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters follow the OWASP Password Storage Cheat Sheet's recommended configuration
 * (19 MiB memory, 2 iterations, 1 degree of parallelism). Memory cost is what makes GPU cracking
 * expensive, which is why it is the parameter we do not trade away for latency.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row must read as "wrong
 * password", never as a 500 that tells an attacker something about the account.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * True when a hash was produced with weaker parameters than we now use, so the password can be
 * transparently upgraded on the next successful login.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

/**
 * Spend roughly the same time on a login for an address that does not exist.
 *
 * Without this, response latency reveals which email addresses are registered, which is exactly
 * the signal credential-stuffing tooling looks for.
 */
export async function fakePasswordVerification(): Promise<void> {
  await hash('smartchat-timing-equaliser', ARGON2_OPTIONS);
}
