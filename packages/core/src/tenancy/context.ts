import {
  ActorType,
  AppError,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorCode,
  type MemberRole,
  Permission,
  type TenantContext,
} from '@smartchat/types';

export interface MembershipLike {
  /** The membership's own id - what conversations, messages and reads reference. */
  id: string;
  accountId: string;
  userId: string;
  displayName?: string | null;
  user?: { name?: string | null } | null;
  baseRole: MemberRole;
  status: string;
  restrictedToProperties: boolean;
  role?: { permissions: string[] } | null;
  properties?: { propertyId: string }[];
}

export interface BuildTenantContextInput {
  membership: MembershipLike;
  requestId: string;
  ip?: string;
  userAgent?: string;
}

function isPermission(value: string): value is Permission {
  return (Object.values(Permission) as string[]).includes(value);
}

/**
 * Resolve the permissions a membership actually carries.
 *
 * A custom role wins when one is assigned; otherwise the built-in defaults for the base role
 * apply. Unknown strings in a custom role are dropped rather than trusted, so a permission that
 * was removed from the product cannot linger in a stored role and grant something unintended.
 */
export function resolvePermissions(membership: MembershipLike): Set<Permission> {
  const source = membership.role?.permissions?.length
    ? membership.role.permissions
    : (DEFAULT_ROLE_PERMISSIONS[membership.baseRole] ?? []);

  const resolved = new Set<Permission>();
  for (const entry of source) {
    if (isPermission(entry)) resolved.add(entry);
  }
  return resolved;
}

/**
 * Build the object every repository requires.
 *
 * This is the only place a `TenantContext` is created from a membership, which is what makes
 * "could a request ever reach the database without tenant scope?" a question with one answer.
 */
export function buildTenantContext(input: BuildTenantContextInput): TenantContext {
  const { membership } = input;

  if (membership.status !== 'active') {
    throw new AppError(ErrorCode.FORBIDDEN, 'Your access to this account has been disabled');
  }

  const context: TenantContext = {
    accountId: membership.accountId,
    userId: membership.userId,
    memberId: membership.id,
    actorType: ActorType.USER,
    role: membership.baseRole,
    permissions: resolvePermissions(membership),
    requestId: input.requestId,
  };

  const name = membership.displayName ?? membership.user?.name;
  if (name) (context as { actorName?: string }).actorName = name;

  if (membership.restrictedToProperties) {
    // An empty set is meaningful: a restricted member with no assignments sees nothing.
    // `canAccessProperty` treats an empty set as unrestricted, so we use a sentinel entry.
    const ids = (membership.properties ?? []).map((p) => p.propertyId);
    (context as { propertyIds?: ReadonlySet<string> }).propertyIds = new Set(
      ids.length > 0 ? ids : ['__none__'],
    );
  }
  if (input.ip !== undefined) (context as { ip?: string }).ip = input.ip;
  if (input.userAgent !== undefined)
    (context as { userAgent?: string }).userAgent = input.userAgent;

  return context;
}

/** A context for background work that legitimately acts on behalf of one account. */
export function systemContext(accountId: string, requestId: string): TenantContext {
  return {
    accountId,
    actorType: ActorType.SYSTEM,
    permissions: new Set(Object.values(Permission)),
    requestId,
  };
}

export function requirePermission(context: TenantContext, permission: Permission): void {
  if (!context.permissions.has(permission)) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, undefined, {
      context: { required: permission, actor: context.userId, account: context.accountId },
    });
  }
}

/**
 * Enforce property scoping.
 *
 * Throws the resource's own not-found error rather than a 403, so a restricted agent cannot use
 * the difference between the two to discover which properties exist.
 */
export function requirePropertyAccess(
  context: TenantContext,
  propertyId: string,
  notFoundCode: ErrorCode = ErrorCode.PROPERTY_NOT_FOUND,
): void {
  if (!context.propertyIds || context.propertyIds.size === 0) return;
  if (!context.propertyIds.has(propertyId)) {
    throw new AppError(notFoundCode, undefined, {
      context: { propertyId, actor: context.userId, account: context.accountId },
    });
  }
}
