import { describe, expect, it } from 'vitest';
import { issueVisitorToken, verifyVisitorToken } from './visitor-token.js';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const NOW = new Date('2026-08-25T12:00:00.000Z');

const base = {
  accountId: 'acc-1',
  propertyId: 'prop-1',
  visitorId: 'vis-1',
  sessionId: 'ses-1',
  ttlSeconds: 3600,
  now: NOW,
};

describe('visitor tokens', () => {
  it('round-trips the identity it was issued for', () => {
    const result = verifyVisitorToken(issueVisitorToken(base, SECRET), SECRET, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.visitorId).toBe('vis-1');
      expect(result.payload.sessionId).toBe('ses-1');
      expect(result.payload.accountId).toBe('acc-1');
    }
  });

  it('rejects a token signed with a different secret', () => {
    const result = verifyVisitorToken(issueVisitorToken(base, OTHER_SECRET), SECRET, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  /**
   * The whole point of checking the signature before parsing: a tampered payload must never reach
   * JSON.parse, let alone be acted on.
   */
  it('rejects a payload edited to impersonate another visitor', () => {
    const token = issueVisitorToken(base, SECRET);
    const [encoded, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    payload.visitorId = 'someone-else';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    expect(verifyVisitorToken(`${forged}.${signature}`, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an expired token', () => {
    const token = issueVisitorToken({ ...base, ttlSeconds: 60 }, SECRET);
    const later = new Date(NOW.getTime() + 61_000);
    expect(verifyVisitorToken(token, SECRET, { now: later })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a token issued for a different property', () => {
    const token = issueVisitorToken(base, SECRET);
    expect(verifyVisitorToken(token, SECRET, { now: NOW, expectedPropertyId: 'prop-2' })).toEqual({
      ok: false,
      reason: 'property_mismatch',
    });
    expect(verifyVisitorToken(token, SECRET, { now: NOW, expectedPropertyId: 'prop-1' }).ok).toBe(
      true,
    );
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'x', 'no-separator-here-at-all', '.abc', 'abc.', 'a'.repeat(5000)]) {
      const result = verifyVisitorToken(bad, SECRET, { now: NOW });
      expect(result.ok).toBe(false);
    }
  });

  it('has no algorithm field an attacker could downgrade', () => {
    const [encoded] = issueVisitorToken(base, SECRET).split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    expect(payload).not.toHaveProperty('alg');
    expect(Object.keys(payload).sort()).toEqual([
      'accountId',
      'exp',
      'iat',
      'propertyId',
      'sessionId',
      'v',
      'visitorId',
    ]);
  });
});
