import { describe, expect, it } from 'vitest';
import {
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptDelayMs,
  signPayload,
  verifySignature,
} from './signature.js';

const SECRET = 'whsec_9f86d081884c7d659a2feaa0c55ad015';
const PAYLOAD = JSON.stringify({ event: 'ticket.created', data: { number: 12 } });
const NOW = 1_730_000_000;

describe('webhook signatures', () => {
  it('a delivery we signed verifies', () => {
    const header = signPayload(SECRET, PAYLOAD, NOW);
    expect(verifySignature(SECRET, PAYLOAD, header, NOW).valid).toBe(true);
  });

  it('the header carries both a timestamp and a versioned signature', () => {
    expect(signPayload(SECRET, PAYLOAD, NOW)).toMatch(/^t=1730000000,v1=[0-9a-f]{64}$/);
  });

  // ---------------------------------------------------------------------------
  // The four ways somebody gets a delivery they should not accept.
  // ---------------------------------------------------------------------------

  it('rejects a body that was changed after signing', () => {
    const header = signPayload(SECRET, PAYLOAD, NOW);
    const tampered = PAYLOAD.replace('12', '13');
    expect(verifySignature(SECRET, tampered, header, NOW)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a signature made with a different secret', () => {
    const header = signPayload('whsec_somebody_elses_secret', PAYLOAD, NOW);
    expect(verifySignature(SECRET, PAYLOAD, header, NOW).valid).toBe(false);
  });

  /**
   * The reason the timestamp is signed at all.
   *
   * Without it, a valid delivery captured once can be replayed at any point in the future and will
   * verify perfectly - the body is unchanged and the HMAC is ours.
   */
  it('rejects a perfectly valid delivery that is six minutes old', () => {
    const header = signPayload(SECRET, PAYLOAD, NOW);
    expect(verifySignature(SECRET, PAYLOAD, header, NOW + 360)).toEqual({
      valid: false,
      reason: 'stale',
    });
    expect(verifySignature(SECRET, PAYLOAD, header, NOW + 299).valid).toBe(true);
  });

  it('rejects a timestamp from the future by the same margin', () => {
    const header = signPayload(SECRET, PAYLOAD, NOW + 400);
    expect(verifySignature(SECRET, PAYLOAD, header, NOW).reason).toBe('stale');
  });

  it('rejects a header that is not one', () => {
    for (const header of ['', 'nonsense', 't=abc,v1=def', 'v1=onlythis', `t=${NOW}`]) {
      expect(verifySignature(SECRET, PAYLOAD, header, NOW).valid).toBe(false);
    }
  });

  it('does not accept a truncated signature', () => {
    const header = signPayload(SECRET, PAYLOAD, NOW);
    const truncated = header.slice(0, header.length - 10);
    expect(verifySignature(SECRET, PAYLOAD, truncated, NOW).valid).toBe(false);
  });
});

describe('retry backoff', () => {
  it('grows, and then stops growing', () => {
    const delays = Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, index) =>
      nextAttemptDelayMs(index),
    );
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] as number);
    }
    expect(delays[0]).toBe(10_000);
    expect(delays.at(-1)).toBe(7_200_000);
  });

  it('spreads six attempts across hours, not seconds', () => {
    const total = Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, index) =>
      nextAttemptDelayMs(index),
    ).reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(3 * 3600 * 1000);
  });
});
