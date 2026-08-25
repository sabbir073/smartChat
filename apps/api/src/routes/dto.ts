import type {
  Account,
  AccountMember,
  Property,
  PropertyDomain,
  Session,
  User,
} from '@smartchat/database';

/**
 * Explicit DTOs.
 *
 * Handlers never return a Prisma model directly — that is how `passwordHash`, `csrfSecret` or a
 * `twoFactorSecret` ends up in a JSON response by accident. Mapping is boring on purpose.
 */

export interface UserDto {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  emailVerified: boolean;
  createdAt: string;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    timezone: user.timezone,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface SessionDto {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export function toSessionDto(session: Session, currentSessionId: string): SessionDto {
  return {
    id: session.id,
    ip: session.ip,
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.id === currentSessionId,
  };
}

export interface AccountDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  locale: string;
  dataRetentionDays: number | null;
  createdAt: string;
}

export function toAccountDto(account: Account): AccountDto {
  return {
    id: account.id,
    name: account.name,
    slug: account.slug,
    status: account.status,
    timezone: account.timezone,
    locale: account.locale,
    dataRetentionDays: account.dataRetentionDays,
    createdAt: account.createdAt.toISOString(),
  };
}

export interface PropertyDto {
  id: string;
  publicId: string;
  name: string;
  websiteUrl: string;
  status: string;
  timezone: string;
  locale: string;
  enforceDomains: boolean;
  installed: boolean;
  installedAt: string | null;
  lastWidgetRequestAt: string | null;
  domains: { id: string; pattern: string; isWildcard: boolean }[];
  createdAt: string;
}

export function toPropertyDto(property: Property & { domains?: PropertyDomain[] }): PropertyDto {
  return {
    id: property.id,
    publicId: property.publicId,
    name: property.name,
    websiteUrl: property.websiteUrl,
    status: property.status,
    timezone: property.timezone,
    locale: property.locale,
    enforceDomains: property.enforceDomains,
    installed: property.installedAt !== null,
    installedAt: property.installedAt?.toISOString() ?? null,
    lastWidgetRequestAt: property.lastWidgetRequestAt?.toISOString() ?? null,
    domains: (property.domains ?? []).map((domain) => ({
      id: domain.id,
      pattern: domain.pattern,
      isWildcard: domain.isWildcard,
    })),
    createdAt: property.createdAt.toISOString(),
  };
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  customRole: { id: string; key: string; name: string } | null;
  status: string;
  availability: string;
  title: string | null;
  restrictedToProperties: boolean;
  propertyIds: string[];
  lastLoginAt: string | null;
  joinedAt: string | null;
}

type MemberRow = AccountMember & {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    lastLoginAt: Date | null;
  };
  role: { id: string; key: string; name: string } | null;
  properties: { propertyId: string }[];
};

export function toMemberDto(member: MemberRow): MemberDto {
  return {
    id: member.id,
    userId: member.user.id,
    email: member.user.email,
    name: member.user.name,
    displayName: member.displayName,
    avatarUrl: member.user.avatarUrl,
    role: member.baseRole,
    customRole: member.role,
    status: member.status,
    availability: member.availability,
    title: member.title,
    restrictedToProperties: member.restrictedToProperties,
    propertyIds: member.properties.map((p) => p.propertyId),
    lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
    joinedAt: member.joinedAt?.toISOString() ?? null,
  };
}
