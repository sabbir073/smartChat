import type { BillingInterval } from '@smartchat/database';

/**
 * Period arithmetic, in one place.
 *
 * Billing dates are where "add a month" quietly becomes wrong. The 31st of January plus one month
 * is not the 31st of February, and a customer who signed up on the 31st must not be billed on the
 * 3rd of March and then drift a further two days every month. So the rule here is: keep the
 * anchor day, clamp it to the length of the target month, and never let the clamp change the
 * anchor for the period after.
 */

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, monthIndex: number): number {
  if (monthIndex === 1 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[monthIndex] as number;
}

/**
 * Add whole months in UTC, clamping the day to the end of the target month.
 *
 * `anchorDay` is the day the subscription started on. Passing it explicitly - rather than reading
 * it off `from` - is what stops February shortening every subsequent month: a subscription
 * anchored on the 31st bills on the 28th in February and back on the 31st in March.
 */
export function addMonths(from: Date, months: number, anchorDay?: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = anchorDay ?? from.getUTCDate();

  const targetMonthAbsolute = month + months;
  const targetYear = year + Math.floor(targetMonthAbsolute / 12);
  const targetMonth = ((targetMonthAbsolute % 12) + 12) % 12;

  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** The end of the period that starts at `start`, for a given billing interval. */
export function periodEnd(start: Date, interval: BillingInterval, anchorDay?: number): Date {
  return addMonths(start, interval === 'yearly' ? 12 : 1, anchorDay);
}

/**
 * What a plan costs for one period, in cents.
 *
 * Reads the stored yearly price rather than multiplying the monthly one, because the annual
 * discount is a commercial decision and not arithmetic.
 */
export function priceForInterval(
  plan: { priceMonthlyCents: number; priceYearlyCents: number },
  interval: BillingInterval,
): number {
  return interval === 'yearly' ? plan.priceYearlyCents : plan.priceMonthlyCents;
}

/** How many months a customer saves by paying for a year at once. Used only for display. */
export function annualSavingMonths(plan: {
  priceMonthlyCents: number;
  priceYearlyCents: number;
}): number {
  if (plan.priceMonthlyCents <= 0 || plan.priceYearlyCents <= 0) return 0;
  const monthsPaid = plan.priceYearlyCents / plan.priceMonthlyCents;
  return Math.max(0, Math.round((12 - monthsPaid) * 10) / 10);
}
