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

/** A clock the caller controls. Test-only, but lives here so the interface has one home. */
export function fixedClock(start: Date | number = 0): Clock & { advance(ms: number): void } {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => new Date(current),
    timestamp: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function isExpired(expiresAt: Date, clock: Clock): boolean {
  return expiresAt.getTime() <= clock.timestamp();
}
