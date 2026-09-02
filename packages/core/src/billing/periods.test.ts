import { describe, expect, it } from 'vitest';
import { addMonths, annualSavingMonths, periodEnd, priceForInterval } from './periods.js';

const at = (iso: string) => new Date(iso);

/**
 * Billing dates are where an off-by-one becomes a refund request, so the awkward months are
 * tested rather than assumed.
 */
describe('addMonths', () => {
  it('adds an ordinary month', () => {
    expect(addMonths(at('2026-03-15T10:00:00.000Z'), 1).toISOString()).toBe(
      '2026-04-15T10:00:00.000Z',
    );
  });

  it('clamps the 31st into a 30-day month', () => {
    expect(addMonths(at('2026-01-31T10:00:00.000Z'), 3).toISOString()).toBe(
      '2026-04-30T10:00:00.000Z',
    );
  });

  it('clamps into February, and into a leap February', () => {
    expect(addMonths(at('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonths(at('2028-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  /**
   * The bug this function exists to avoid: without an anchor, a subscription that starts on the
   * 31st is billed on the 28th in February and then stays on the 28th for ever, quietly moving
   * every customer's billing date three days earlier after one short month.
   */
  it('returns to the anchor day after a short month', () => {
    const start = at('2026-01-31T00:00:00.000Z');
    const february = addMonths(start, 1, 31);
    expect(february.toISOString()).toBe('2026-02-28T00:00:00.000Z');

    const march = addMonths(february, 1, 31);
    expect(march.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(addMonths(at('2026-11-15T00:00:00.000Z'), 2).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('adds twelve months for an annual period, leap year included', () => {
    expect(addMonths(at('2028-02-29T00:00:00.000Z'), 12).toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });
});

describe('periodEnd', () => {
  it('is one month out for monthly and twelve for yearly', () => {
    const start = at('2026-06-10T09:30:00.000Z');
    expect(periodEnd(start, 'monthly').toISOString()).toBe('2026-07-10T09:30:00.000Z');
    expect(periodEnd(start, 'yearly').toISOString()).toBe('2027-06-10T09:30:00.000Z');
  });
});

describe('priceForInterval', () => {
  const starter = { priceMonthlyCents: 2900, priceYearlyCents: 29_000 };

  it('reads the stored annual price rather than multiplying', () => {
    expect(priceForInterval(starter, 'monthly')).toBe(2900);
    expect(priceForInterval(starter, 'yearly')).toBe(29_000);
    // The point: 12 x 2900 would be 34,800. The discount is data, not arithmetic.
    expect(priceForInterval(starter, 'yearly')).not.toBe(starter.priceMonthlyCents * 12);
  });
});

describe('annualSavingMonths', () => {
  it('reports two months free on the seeded plans', () => {
    expect(annualSavingMonths({ priceMonthlyCents: 2900, priceYearlyCents: 29_000 })).toBe(2);
    expect(annualSavingMonths({ priceMonthlyCents: 9900, priceYearlyCents: 99_000 })).toBe(2);
  });

  it('claims no saving on a free plan rather than dividing by zero', () => {
    expect(annualSavingMonths({ priceMonthlyCents: 0, priceYearlyCents: 0 })).toBe(0);
  });
});
