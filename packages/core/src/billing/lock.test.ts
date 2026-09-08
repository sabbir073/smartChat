import { describe, expect, it } from 'vitest';
import { evaluateLock } from './lock.js';

const now = new Date('2026-09-08T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const base = { pastDueSince: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };

describe('evaluateLock', () => {
  it('leaves a paid-up or free account alone', () => {
    expect(evaluateLock({ ...base, status: 'active' }, 3, now).locked).toBe(false);
    expect(evaluateLock({ ...base, status: 'none' }, 3, now).locked).toBe(false);
  });

  it('locks when Stripe has given up collecting', () => {
    expect(evaluateLock({ ...base, status: 'unpaid' }, 3, now)).toEqual({
      locked: true,
      reason: 'unpaid',
      graceEndsAt: null,
    });
  });

  /**
   * One failed charge is not non-payment. Stripe retries for days; locking somebody out the
   * minute their bank hiccups is how a paying customer stops being one.
   */
  it('gives a past-due account the grace window before locking', () => {
    const pastDueSince = new Date(now.getTime() - 2 * day);
    const verdict = evaluateLock({ ...base, status: 'past_due', pastDueSince }, 3, now);
    expect(verdict.locked).toBe(false);
    expect(verdict.graceEndsAt).toEqual(new Date(pastDueSince.getTime() + 3 * day));
  });

  it('locks once the grace window has passed', () => {
    const pastDueSince = new Date(now.getTime() - 4 * day);
    const verdict = evaluateLock({ ...base, status: 'past_due', pastDueSince }, 3, now);
    expect(verdict.locked).toBe(true);
    expect(verdict.reason).toBe('grace_expired');
  });

  it('locks immediately when the operator sets no grace at all', () => {
    const pastDueSince = new Date(now.getTime() - 1000);
    expect(evaluateLock({ ...base, status: 'past_due', pastDueSince }, 0, now).locked).toBe(true);
  });

  it('starts the grace clock now when nobody recorded when it began', () => {
    const verdict = evaluateLock({ ...base, status: 'past_due', pastDueSince: null }, 3, now);
    expect(verdict.locked).toBe(false);
    expect(verdict.graceEndsAt).toEqual(new Date(now.getTime() + 3 * day));
  });

  /** A customer who cancelled keeps what they paid for until the period ends. */
  it('does not lock a cancelled subscription before its paid period ends', () => {
    const currentPeriodEnd = new Date(now.getTime() + 10 * day);
    expect(
      evaluateLock({ ...base, status: 'canceled', currentPeriodEnd }, 3, now).locked,
    ).toBe(false);
  });

  it('locks a cancelled subscription once the paid period is over', () => {
    const currentPeriodEnd = new Date(now.getTime() - day);
    expect(evaluateLock({ ...base, status: 'canceled', currentPeriodEnd }, 3, now)).toEqual({
      locked: true,
      reason: 'canceled',
      graceEndsAt: null,
    });
  });

  it('does not lock while a first payment is still being attempted', () => {
    expect(evaluateLock({ ...base, status: 'incomplete' }, 3, now).locked).toBe(false);
  });

  it('locks when that first attempt has expired', () => {
    expect(evaluateLock({ ...base, status: 'incomplete_expired' }, 3, now).reason).toBe(
      'incomplete',
    );
  });
});
