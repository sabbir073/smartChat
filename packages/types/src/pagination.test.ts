import { describe, expect, it } from 'vitest';
import { clampLimit, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from './pagination.js';

describe('clampLimit', () => {
  it('falls back to the default when nothing is requested', () => {
    expect(clampLimit(undefined)).toBe(PAGE_SIZE_DEFAULT);
  });

  it('rejects non-finite values instead of propagating NaN into a query', () => {
    expect(clampLimit(Number.NaN)).toBe(PAGE_SIZE_DEFAULT);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(PAGE_SIZE_DEFAULT);
  });

  it('never allows a caller to request an unbounded page', () => {
    expect(clampLimit(10_000)).toBe(PAGE_SIZE_MAX);
  });

  it('floors fractional values and enforces a minimum of one', () => {
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });
});
