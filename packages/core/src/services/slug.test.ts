import { describe, expect, it } from 'vitest';
import { slugify, uniqueSlug } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('ABC Digital')).toBe('abc-digital');
  });

  it('folds diacritics instead of dropping the letters', () => {
    expect(slugify('Café Noir')).toBe('cafe-noir');
    expect(slugify('Über Straße')).toBe('uber-strasse');
    expect(slugify('Ålesund Ægir')).toBe('alesund-aegir');
  });

  it('collapses punctuation and trims stray hyphens', () => {
    expect(slugify('  --Hello, World!!  ')).toBe('hello-world');
  });

  it('produces something usable from input with no latin characters', () => {
    expect(slugify('日本語').length).toBeGreaterThanOrEqual(2);
  });

  it('respects the maximum length without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30), 31);
    expect(slug.length).toBeLessThanOrEqual(31);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    expect(await uniqueSlug('ABC Digital', async () => false)).toBe('abc-digital');
  });

  it('appends a counter until it finds a free slug', async () => {
    const taken = new Set(['abc-digital', 'abc-digital-2', 'abc-digital-3']);
    expect(await uniqueSlug('ABC Digital', async (c) => taken.has(c))).toBe('abc-digital-4');
  });

  it('falls back to entropy rather than looping forever', async () => {
    const slug = await uniqueSlug('Popular Name', async () => true, 3);
    expect(slug).toMatch(/^popular-name-[a-z0-9]{4,6}$/);
  });
});
