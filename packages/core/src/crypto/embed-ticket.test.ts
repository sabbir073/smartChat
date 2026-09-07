import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMBED_TICKET_TTL_SECONDS, issueEmbedTicket, verifyEmbedTicket } from './embed-ticket.js';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);
const now = new Date('2026-09-07T12:00:00Z');

function ticket(overrides: Partial<{ publicId: string; host: string; ttlSeconds: number }> = {}) {
  return issueEmbedTicket(
    { publicId: 'prp_01ABCDEFGHJK', host: 'example.com', now, ...overrides },
    SECRET,
  );
}

describe('embed ticket', () => {
  it('round-trips the host the loader was seen on', () => {
    const result = verifyEmbedTicket(ticket(), SECRET, { now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.h).toBe('example.com');
      expect(result.payload.p).toBe('prp_01ABCDEFGHJK');
    }
  });

  it('lowercases the host, so a matcher never has to', () => {
    const result = verifyEmbedTicket(ticket({ host: 'EXAMPLE.COM' }), SECRET, { now });
    expect(result.ok && result.payload.h).toBe('example.com');
  });

  /**
   * The whole point. A panel that could mint its own ticket would be back to trusting a value the
   * page controls, which is the bug this replaces rather than a fix for it.
   */
  it('refuses a ticket signed with another secret', () => {
    const forged = issueEmbedTicket(
      { publicId: 'prp_01ABCDEFGHJK', host: 'evil.test', now },
      OTHER,
    );
    expect(verifyEmbedTicket(forged, SECRET, { now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a ticket whose payload was edited', () => {
    const original = ticket();
    const [encoded, signature] = original.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, p: 'prp_01ABCDEFGHJK', h: 'evil.test', iat: 0, exp: 9_999_999_999 }),
      'utf8',
    ).toString('base64url');
    expect(encoded).not.toBe(tampered);
    expect(verifyEmbedTicket(`${tampered}.${signature}`, SECRET, { now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a ticket issued for another property', () => {
    expect(
      verifyEmbedTicket(ticket(), SECRET, { now, expectedPublicId: 'prp_01ZZZZZZZZZZ' }),
    ).toEqual({ ok: false, reason: 'property_mismatch' });
  });

  it('expires', () => {
    const later = new Date(now.getTime() + (EMBED_TICKET_TTL_SECONDS + 1) * 1000);
    expect(verifyEmbedTicket(ticket(), SECRET, { now: later })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('is still valid a moment before it expires', () => {
    const later = new Date(now.getTime() + (EMBED_TICKET_TTL_SECONDS - 1) * 1000);
    expect(verifyEmbedTicket(ticket(), SECRET, { now: later }).ok).toBe(true);
  });

  it.each(['', 'x', 'no-dot-here-but-long-enough', '.abc', 'abc.', 'a'.repeat(3000)])(
    'refuses malformed input %#',
    (value) => {
      expect(verifyEmbedTicket(value, SECRET, { now }).ok).toBe(false);
    },
  );

  it('refuses a payload that is valid base64 but not a ticket', () => {
    const encoded = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
    expect(verifyEmbedTicket(`${encoded}.${signature}`, SECRET, { now })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
