import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';

/**
 * Derive a purpose-bound key from the master `ENCRYPTION_KEY`.
 *
 * Separate purposes get separate keys, so a weakness in one use (say, 2FA secrets) cannot be
 * carried over to another.
 */
function deriveKey(masterKey: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'smartchat-encryption', purpose, 32));
}

/**
 * Authenticated encryption for values we must be able to read back — currently TOTP secrets.
 *
 * Output format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is what makes key
 * rotation possible later without guessing at the format of existing rows.
 */
export function encryptSecret(plaintext: string, masterKey: string, purpose = 'default'): string {
  const key = deriveKey(masterKey, purpose);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, masterKey: string, purpose = 'default'): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised ciphertext format');
  }
  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart!, 'base64url');
  const tag = Buffer.from(tagPart!, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Unrecognised ciphertext format');
  }
  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey, purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart!, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
