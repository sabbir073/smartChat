import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandMark } from './brand-mark';

afterEach(cleanup);

/**
 * The wordmark was a `<span>` on the sign-in, error and 404 pages — the three screens somebody is
 * most likely to click it from, because it is the only thing on them that looks like a way out.
 */
describe('BrandMark', () => {
  it('is a link to the home page by default', () => {
    render(<BrandMark />);
    expect(screen.getByRole('link', { name: 'SmartChat home' }).getAttribute('href')).toBe('/');
  });

  it('points wherever home is for the surface it sits on', () => {
    render(<BrandMark href="/app" label="Dashboard home" />);
    expect(screen.getByRole('link', { name: 'Dashboard home' }).getAttribute('href')).toBe('/app');
  });

  it('names itself for a screen reader rather than reading out the logo', () => {
    render(<BrandMark />);
    expect(screen.getByRole('link', { name: 'SmartChat home' })).not.toBeNull();
  });
});
