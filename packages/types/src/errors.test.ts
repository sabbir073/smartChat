import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from './errors.js';

describe('AppError.toBody', () => {
  it('shows a 4xx message to the caller', () => {
    const body = new AppError(ErrorCode.PLAN_LIMIT_REACHED, 'Your plan includes 1 website.').toBody();
    expect(body.message).toBe('Your plan includes 1 website.');
  });

  it('hides an internal 5xx message', () => {
    const body = new AppError(ErrorCode.INTERNAL_ERROR, 'pool exhausted on db-3').toBody();
    expect(body.message).toBe('An unexpected error occurred');
  });

  /** The two 5xx codes written for a person: "not set up here" and "the provider said no". */
  it('shows the billing-not-configured and payment-provider messages', () => {
    expect(new AppError(ErrorCode.BILLING_NOT_CONFIGURED).toBody().message).toBe(
      'Payments are not set up on this installation yet.',
    );
    expect(new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR).toBody().message).toMatch(/payment provider/);
    expect(new AppError(ErrorCode.BILLING_NOT_CONFIGURED).status).toBe(503);
  });
});
