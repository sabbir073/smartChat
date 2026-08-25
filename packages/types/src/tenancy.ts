import type { Permission } from './permissions.js';
import type { MemberRole } from './enums.js';

/**
 * The object that makes tenant scoping impossible to forget.
 *
 * Every repository function in `@smartchat/core` takes one of these as its first argument and
 * injects `accountId` into the query. There is no repository entry point that does not.
 */
export interface TenantContext {
  accountId: string;
  /** Present for user-driven requests, absent for API-key and system actors. */
  userId?: string;
  actorType: ActorType;
  role?: MemberRole;
  permissions: ReadonlySet<Permission>;
  /**
   * When set, the actor may only touch these properties. Empty/undefined means account-wide access
   * (subject to permissions).
   */
  propertyIds?: ReadonlySet<string>;
  requestId: string;
  ip?: string;
  userAgent?: string;
}

export const ActorType = {
  USER: 'user',
  API_KEY: 'api_key',
  VISITOR: 'visitor',
  SYSTEM: 'system',
  PLATFORM_ADMIN: 'platform_admin',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/** Visitor-scoped context. A visitor is never given a TenantContext. */
export interface VisitorContext {
  accountId: string;
  propertyId: string;
  visitorId: string;
  sessionId: string;
  requestId: string;
  ip?: string;
  userAgent?: string;
  origin?: string;
}

export function hasPermission(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function canAccessProperty(ctx: TenantContext, propertyId: string): boolean {
  if (!ctx.propertyIds || ctx.propertyIds.size === 0) return true;
  return ctx.propertyIds.has(propertyId);
}
