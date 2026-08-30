import type {
  Account,
  AccountMember,
  ApiKey,
  Contact,
  KbArticle,
  KbCategory,
  Property,
  PropertyDomain,
  Session,
  Shortcut,
  Ticket,
  TicketMessage,
  User,
  Webhook,
  WebhookDelivery,
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
  /** The customer's own mailbox for ticket replies. Null means "not monitored", and we say so. */
  supportEmail: string | null;
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
    supportEmail: property.supportEmail,
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

export interface KbCategoryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
}

export function toCategoryDto(category: KbCategory): KbCategoryDto {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    position: category.position,
  };
}

export interface KbArticleDto {
  id: string;
  propertyId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string;
  status: string;
  category: { id: string; name: string; slug: string } | null;
  publishedAt: string | null;
  viewCount: number;
  updatedAt: string;
}

export function toArticleDto(
  article: KbArticle & { category?: KbCategory | null },
): KbArticleDto {
  return {
    id: article.id,
    propertyId: article.propertyId,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    body: article.body,
    status: article.status,
    category: article.category
      ? { id: article.category.id, name: article.category.name, slug: article.category.slug }
      : null,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    viewCount: article.viewCount,
    updatedAt: article.updatedAt.toISOString(),
  };
}

export interface TicketDto {
  id: string;
  number: number;
  propertyId: string;
  contactId: string | null;
  conversationId: string | null;
  subject: string;
  status: string;
  priority: string;
  tags: string[];
  requesterEmail: string;
  requesterName: string | null;
  assignedMemberId: string | null;
  assignedMemberName: string | null;
  departmentId: string | null;
  firstResponseAt: string | null;
  lastMessageAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export function toTicketDto(
  ticket: Ticket & {
    assignedMember?: { displayName: string | null; user?: { name: string | null } | null } | null;
  },
): TicketDto {
  return {
    id: ticket.id,
    number: ticket.number,
    propertyId: ticket.propertyId,
    contactId: ticket.contactId,
    conversationId: ticket.conversationId,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    tags: ticket.tags,
    requesterEmail: ticket.requesterEmail,
    requesterName: ticket.requesterName,
    assignedMemberId: ticket.assignedMemberId,
    assignedMemberName:
      ticket.assignedMember?.displayName ?? ticket.assignedMember?.user?.name ?? null,
    departmentId: ticket.departmentId,
    firstResponseAt: ticket.firstResponseAt?.toISOString() ?? null,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
  };
}

export interface TicketMessageDto {
  id: string;
  seq: number;
  authorType: string;
  authorMemberId: string | null;
  visibility: string;
  body: string;
  createdAt: string;
}

export function toTicketMessageDto(message: TicketMessage): TicketMessageDto {
  return {
    id: message.id,
    seq: message.seq,
    authorType: message.authorType,
    authorMemberId: message.authorMemberId,
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

export interface ApiKeyDto {
  id: string;
  name: string;
  /** An id, not a secret. It is what a person recognises a key by once the secret is gone. */
  prefix: string;
  scopes: string[];
  propertyIds: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function toApiKeyDto(key: ApiKey): ApiKeyDto {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    propertyIds: key.propertyIds,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  disabledAt: string | null;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/**
 * Note the parameter type: `Webhook` without its `secret`.
 *
 * The service strips it before anything reaches here, so there is no code path in which a
 * forgotten field could put a signing secret into a JSON response - the type would not compile.
 */
export function toWebhookDto(webhook: Omit<Webhook, 'secret'>): WebhookDto {
  return {
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    consecutiveFailures: webhook.consecutiveFailures,
    disabledAt: webhook.disabledAt?.toISOString() ?? null,
    disabledReason: webhook.disabledReason,
    lastDeliveryAt: webhook.lastDeliveryAt?.toISOString() ?? null,
    createdAt: webhook.createdAt.toISOString(),
  };
}

export interface WebhookDeliveryDto {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export function toWebhookDeliveryDto(delivery: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    responseStatus: delivery.responseStatus,
    error: delivery.error,
    nextAttemptAt: delivery.nextAttemptAt.toISOString(),
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  };
}
