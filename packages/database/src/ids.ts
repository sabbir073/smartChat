import { v7 as uuidv7 } from 'uuid';

/**
 * Primary keys are UUIDv7: time-sortable, so B-tree inserts stay at the right edge of the index
 * even at 10^8 rows, while remaining globally unique and non-enumerable.
 */
export function newId(): string {
  return uuidv7();
}

/**
 * Crockford base32 — no I, L, O or U, so a public id read aloud or retyped from a screenshot
 * cannot be ambiguous.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export const ID_PREFIX = {
  property: 'prp',
  apiKey: 'sck',
  webhook: 'whk',
  ticket: 'tkt',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/**
 * Public identifier for objects a browser sees before it is authenticated — most importantly the
 * property id embedded in a customer's installation snippet. 16 base32 characters is 80 bits of
 * entropy, so these cannot be guessed or enumerated.
 */
export function newPublicId(prefix: IdPrefix, length = 16): string {
  return `${prefix}_${randomBase32(length)}`;
}

const PUBLIC_ID_PATTERN = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/;

export function isPublicId(value: string, prefix?: IdPrefix): boolean {
  if (!PUBLIC_ID_PATTERN.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}
