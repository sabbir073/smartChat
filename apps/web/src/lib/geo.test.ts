import { describe, expect, it } from 'vitest';
import { countryFlag, countryName, pageLabel, pagePath } from './geo';

describe('countryFlag', () => {
  it('turns a code into regional-indicator letters', () => {
    expect(countryFlag('BD')).toBe('🇧🇩');
    expect(countryFlag('us')).toBe('🇺🇸');
    expect(countryFlag('EU')).toBe('🇪🇺');
  });

  it('has nothing to show for a region without a flag, or for no code', () => {
    expect(countryFlag('AP')).toBeNull();
    expect(countryFlag(null)).toBeNull();
    expect(countryFlag('')).toBeNull();
    expect(countryFlag('USA')).toBeNull();
  });
});

describe('countryName', () => {
  it('names a country in English by default', () => {
    expect(countryName('BD')).toBe('Bangladesh');
    expect(countryName('gb')).toBe('United Kingdom');
  });

  it('spells out the registries’ regional codes', () => {
    expect(countryName('EU')).toBe('European Union');
    expect(countryName('AP')).toBe('Asia-Pacific region');
  });

  it('falls back to the code rather than inventing a name', () => {
    expect(countryName('XX')).toBe('XX');
    expect(countryName(null)).toBeNull();
  });
});

describe('pageLabel', () => {
  it('prefers the title', () => {
    expect(pageLabel({ url: 'https://example.com/pricing', title: 'Pricing – Example' })).toBe(
      'Pricing – Example',
    );
  });

  it('falls back to the path, never the full URL', () => {
    expect(pageLabel({ url: 'https://example.com/pricing?plan=pro', title: '' })).toBe(
      '/pricing?plan=pro',
    );
    expect(pageLabel({ url: 'https://example.com/pricing', title: null })).toBe('/pricing');
  });

  it('shows the host for the home page, which has no path worth reading', () => {
    expect(pageLabel({ url: 'https://example.com/', title: '' })).toBe('example.com');
  });

  it('is empty for nothing', () => {
    expect(pageLabel(null)).toBeNull();
    expect(pageLabel({ url: '' })).toBeNull();
  });
});

describe('pagePath', () => {
  it('keeps path and query, drops the rest', () => {
    expect(pagePath('https://example.com/a/b?x=1#frag')).toBe('/a/b?x=1');
    expect(pagePath('https://example.com')).toBe('/');
    expect(pagePath(null)).toBeNull();
  });
});
