import type { TenantContext } from '@smartchat/types';

/**
 * The tenant predicate injected into every query against a tenant-owned model.
 *
 * Repositories spread this into their `where` clause. It exists as a function rather than a
 * literal so that the day tenancy grows a second dimension, there is exactly one place to change.
 */
export function tenantScope(context: TenantContext): { accountId: string } {
  return { accountId: context.accountId };
}

/** Restricts a query to the properties a restricted member may see. */
export function propertyScope(context: TenantContext): { propertyId?: { in: string[] } } {
  if (!context.propertyIds || context.propertyIds.size === 0) return {};
  return { propertyId: { in: [...context.propertyIds] } };
}

export function notDeleted(): { deletedAt: null } {
  return { deletedAt: null };
}

/**
 * Encode/decode a keyset cursor.
 *
 * Base64 of `createdAt|id`. It is validated on the way back in and always combined with the
 * tenant predicate, so a cursor forged from another tenant's row simply returns nothing.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Keyset predicate for a `(createdAt DESC, id DESC)` ordering.
 * Ties on `createdAt` are broken by `id`, so no row is ever skipped or repeated.
 */
export function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const decoded = decodeCursor(cursor);
  if (!decoded) return {};
  return {
    OR: [
      { createdAt: { lt: decoded.createdAt } },
      { createdAt: decoded.createdAt, id: { lt: decoded.id } },
    ],
  };
}
