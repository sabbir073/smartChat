import { describe, expect, it } from 'vitest';
import { ActorType, type TenantContext } from '@smartchat/types';
import { afterCursor, decodeCursor, encodeCursor, propertyScope, tenantScope } from './scope.js';

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    accountId: 'acc-1',
    actorType: ActorType.USER,
    permissions: new Set(),
    requestId: 'req-1',
    ...overrides,
  };
}

describe('tenantScope', () => {
  it('always produces an account predicate', () => {
    expect(tenantScope(ctx())).toEqual({ accountId: 'acc-1' });
  });
});

describe('propertyScope', () => {
  it('is unrestricted when the member has no property restriction', () => {
    expect(propertyScope(ctx())).toEqual({});
    expect(propertyScope(ctx({ propertyIds: new Set() }))).toEqual({});
  });

  it('restricts to the assigned properties', () => {
    expect(propertyScope(ctx({ propertyIds: new Set(['p1', 'p2']) }))).toEqual({
      propertyId: { in: ['p1', 'p2'] },
    });
  });
});

describe('cursors', () => {
  it('round-trips', () => {
    const when = new Date('2026-08-25T10:00:00.000Z');
    const decoded = decodeCursor(encodeCursor(when, 'row-1'));
    expect(decoded?.createdAt.toISOString()).toBe(when.toISOString());
    expect(decoded?.id).toBe('row-1');
  });

  it('rejects garbage instead of throwing into a query', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('nopipe').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('not-a-date|id').toString('base64url'))).toBeNull();
  });

  it('degrades to an unfiltered first page rather than erroring on a bad cursor', () => {
    expect(afterCursor('garbage')).toEqual({});
    expect(afterCursor(undefined)).toEqual({});
  });

  it('breaks createdAt ties by id so rows are never skipped or repeated', () => {
    const when = new Date('2026-08-25T10:00:00.000Z');
    expect(afterCursor(encodeCursor(when, 'row-5'))).toEqual({
      OR: [{ createdAt: { lt: when } }, { createdAt: when, id: { lt: 'row-5' } }],
    });
  });
});
