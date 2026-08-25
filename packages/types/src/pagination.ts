/** Cursor pagination contract, shared by every list endpoint. */

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

export interface CursorPageRequest {
  /** Opaque cursor from a previous response. Validated server-side, never trusted. */
  cursor?: string;
  limit?: number;
}

export interface CursorPageMeta {
  cursor: string | null;
  hasMore: boolean;
  /** Only populated where an exact count is cheap. Never computed on `messages`. */
  total?: number;
}

export interface CursorPage<T> {
  items: T[];
  meta: CursorPageMeta;
}

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return PAGE_SIZE_DEFAULT;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  if (n > PAGE_SIZE_MAX) return PAGE_SIZE_MAX;
  return n;
}
