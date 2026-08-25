import { describe, expect, it } from 'vitest';
import { ID_PREFIX, isPublicId, newId, newPublicId } from './ids.js';

describe('newId', () => {
  it('produces version 7 uuids', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is monotonic enough to keep index inserts at the right edge', () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
  });
});

describe('newPublicId', () => {
  it('is prefixed and unambiguous to retype', () => {
    const id = newPublicId(ID_PREFIX.property);
    expect(id.startsWith('prp_')).toBe(true);
    expect(id.slice(4)).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(id).not.toMatch(/[ILOU]/);
  });

  it('validates prefix as well as shape', () => {
    const property = newPublicId(ID_PREFIX.property);
    expect(isPublicId(property, ID_PREFIX.property)).toBe(true);
    expect(isPublicId(property, ID_PREFIX.webhook)).toBe(false);
    expect(isPublicId('not-a-public-id')).toBe(false);
    expect(isPublicId('prp_short')).toBe(false);
  });

  it('has enough entropy that collisions do not happen in practice', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newPublicId(ID_PREFIX.property)));
    expect(ids.size).toBe(5000);
  });
});
