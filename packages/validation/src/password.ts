import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Deliberately not a composition rule ("one upper, one digit, one symbol").
 *
 * Modern guidance (NIST SP 800-63B) is that composition rules push people toward predictable
 * substitutions while blocking good passphrases. Length plus a blocklist is measurably stronger.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'welcome123',
  'monkey1234',
  'dragon1234',
  'sunshine12',
  'princess12',
  'football12',
  'baseball12',
  'trustno1234',
  'abc123456',
  'changeme12',
  'smartchat1',
  'smartchat123',
]);

function isSequential(value: string): boolean {
  const lowered = value.toLowerCase();
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < lowered.length; i += 1) {
    const delta = lowered.charCodeAt(i) - lowered.charCodeAt(i - 1);
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    if (ascending >= 6 || descending >= 6) return true;
  }
  return false;
}

function isRepeated(value: string): boolean {
  return /^(.)\1+$/.test(value) || /(.)\1{5,}/.test(value);
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, 'That password is too long')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), 'That password is too common')
  .refine((value) => !isRepeated(value), 'Use more than one repeated character')
  .refine((value) => !isSequential(value), 'Avoid long runs like "abcdefg" or "123456"');

/**
 * A password must not simply restate the account it protects. Applied where both values are
 * known — registration, reset and change.
 */
export function passwordIsDerivedFrom(
  password: string,
  ...values: (string | undefined)[]
): boolean {
  const lowered = password.toLowerCase();
  return values.some((value) => {
    if (!value) return false;
    const local = value.includes('@') ? value.split('@')[0]! : value;
    const normalised = local.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalised.length < 4) return false;
    return lowered.replace(/[^a-z0-9]/g, '').includes(normalised);
  });
}
