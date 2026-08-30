import type {
  Account,
  AccountMember,
  Contact,
  Property,
  PropertyDomain,
  Session,
  Shortcut,
  User,
} from '@smartchat/database';
import type { ResolvedTrigger } from '@smartchat/core';
import type { TriggerAction, TriggerCondition } from '@smartchat/validation';

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
  departmentIds: string[];
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
  departments: { departmentId: string }[];
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
    departmentIds: member.departments.map((d) => d.departmentId),
    lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
    joinedAt: member.joinedAt?.toISOString() ?? null,
  };
}

export interface TriggerDto {
  id: string;
  name: string;
  description: string | null;
  propertyId: string | null;
  event: string;
  enabled: boolean;
  match: string;
  conditions: TriggerCondition[];
  actions: TriggerAction[];
  frequency: string;
  cooldownSeconds: number;
  afterSeconds: number;
  position: number;
  /** Real counters, maintained on every firing - not an estimate and not a placeholder. */
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTriggerDto(trigger: ResolvedTrigger): TriggerDto {
  return {
    id: trigger.id,
    name: trigger.name,
    description: trigger.description,
    propertyId: trigger.propertyId,
    event: trigger.event,
    enabled: trigger.enabled,
    match: trigger.match,
    conditions: trigger.conditions,
    actions: trigger.actions,
    frequency: trigger.frequency,
    cooldownSeconds: trigger.cooldownSeconds,
    afterSeconds: trigger.afterSeconds,
    position: trigger.position,
    fireCount: trigger.fireCount,
    lastFiredAt: trigger.lastFiredAt?.toISOString() ?? null,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
}

export interface ShortcutDto {
  id: string;
  key: string;
  title: string;
  body: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toShortcutDto(shortcut: Shortcut): ShortcutDto {
  return {
    id: shortcut.id,
    key: shortcut.key,
    title: shortcut.title,
    body: shortcut.body,
    usageCount: shortcut.usageCount,
    createdAt: shortcut.createdAt.toISOString(),
    updatedAt: shortcut.updatedAt.toISOString(),
  };
}

export interface ContactDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  customFields: Record<string, string>;
  /** How many browser identities we have joined to this person, and on which websites. */
  visitorCount: number;
  propertyIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export function toContactDto(
  contact: Contact & { visitors?: { id: string; propertyId: string }[] },
): ContactDto {
  const visitors = contact.visitors ?? [];
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    notes: contact.notes,
    customFields: (contact.customFields ?? {}) as Record<string, string>,
    visitorCount: visitors.length,
    propertyIds: [...new Set(visitors.map((visitor) => visitor.propertyId))],
    firstSeenAt: contact.firstSeenAt.toISOString(),
    lastSeenAt: contact.lastSeenAt.toISOString(),
  };
}
