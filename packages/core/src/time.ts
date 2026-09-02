/**
 * Time is injected everywhere it matters.
 *
 * Expiry, lockout windows, retention and rate limits are all time-dependent, and a test that has
 * to sleep to exercise them is a slow test that eventually becomes a flaky one.
 */
export interface Clock {
  now(): Date;
  timestamp(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  timestamp: () => Date.now(),
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
