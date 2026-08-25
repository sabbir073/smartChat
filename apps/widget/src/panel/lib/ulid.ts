const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

/**
 * A ULID: 48 bits of timestamp followed by 80 bits of randomness, Crockford base32.
 *
 * Used as the client-generated message id. Two properties matter here: it is unguessable, and it
 * sorts by creation time, which makes an optimistic message list stable before the server has
 * assigned real sequence numbers.
 *
 * Written out rather than added as a dependency because it is fifteen lines and this bundle is
 * downloaded by every visitor who opens the chat.
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = now;
  for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
    time = ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = new Uint8Array(RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let random = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    random += ALPHABET[(bytes[i] as number) % 32];
  }

  return time + random;
}
