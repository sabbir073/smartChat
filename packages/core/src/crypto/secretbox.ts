import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secrets the operator types into the console - a Stripe secret key, a webhook signing secret -
 * have to live somewhere, and "somewhere" is a database column that ends up in every backup.
 * They are encrypted here before they are written and decrypted only in the process that uses
 * them, with a key that lives in the environment and nowhere else.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather than decrypting to
 * garbage; a fresh random nonce per value, so two identical secrets do not produce two identical
 * rows. The stored form names its version so the algorithm can change later without ambiguity:
 *
 *   v1:<nonce base64url>:<tag base64url>:<ciphertext base64url>
 *
 * This is not a general-purpose vault and does not try to be. It makes a database dump useless
 * to whoever obtains one without also obtaining the environment - which is the threat a backup
 * that leaks actually represents.
 */

export const SECRETBOX_VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export class SecretBox {
  private readonly key: Buffer;

  /** @param hexKey 64 hex characters (32 bytes). Generate with `openssl rand -hex 32`. */
  constructor(hexKey: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
      throw new Error('SecretBox key must be 64 hex characters (32 bytes)');
    }
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== KEY_BYTES) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      SECRETBOX_VERSION,
      nonce.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  open(sealed: string): string {
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== SECRETBOX_VERSION) {
      throw new Error('Sealed value is not in a form this key can open');
    }
    const [, nonce, tag, ciphertext] = parts as [string, string, string, string];
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    // A wrong key or a modified ciphertext throws here, on `final`. That is the point.
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  static isSealed(value: string): boolean {
    return value.startsWith(`${SECRETBOX_VERSION}:`) && value.split(':').length === 4;
  }
}
