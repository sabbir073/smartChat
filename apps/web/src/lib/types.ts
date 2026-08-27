/** Response shapes the dashboard consumes. These mirror the API's DTOs, not its database models. */

export interface PropertyDomainDto {
  id: string;
  pattern: string;
  isWildcard: boolean;
}

export interface PropertyDto {
  id: string;
  publicId: string;
  name: string;
  websiteUrl: string;
  status: 'active' | 'paused';
  timezone: string;
  locale: string;
  enforceDomains: boolean;
  installed: boolean;
  installedAt: string | null;
  lastWidgetRequestAt: string | null;
  domains: PropertyDomainDto[];
  createdAt: string;
}

export interface InstallationDto {
  publicId: string;
  loaderUrl: string;
  snippet: string;
  verified: boolean;
  lastRequestAt: string | null;
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
}

export interface DepartmentDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

export interface InvitationDto {
  id: string;
  email: string;
  baseRole: string;
  createdAt: string;
  /** Empty when the link has lapsed - reported rather than hidden, so it can be resent. */
  expiresAt: string;
  invitedByName: string | null;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  /** An optional named permission set layered over the base role. */
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

export interface ConversationDto {
  id: string;
  propertyId: string;
  status: 'open' | 'pending' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  channel: string;
  subject: string | null;
  tags: string[];
  assignedMemberId: string | null;
  lastMessageAt: string;
  startedAt: string;
  closedAt: string | null;
  agentUnreadCount: number;
  messageSeq: number;
  /** Answers from the pre-chat or offline form, in the order the customer configured them. */
  preChat: { key: string; value: string }[];
  visitor: {
    id: string;
    name: string | null;
    email: string | null;
    browser: string | null;
    os: string | null;
    deviceType: string;
    country: string | null;
    language: string | null;
    isReturning: boolean;
  };
}

export interface TriggerCondition {
  field: string;
  operator: string;
  value: string;
}

export type TriggerAction =
  | { type: 'send_message'; body: string }
  | { type: 'add_tag'; tag: string }
  | { type: 'set_priority'; priority: 'low' | 'normal' | 'high' | 'urgent' }
  | { type: 'route_to_department'; departmentId: string };

export interface TriggerDto {
  id: string;
  name: string;
  description: string | null;
  propertyId: string | null;
  event: 'visitor_arrived' | 'page_viewed' | 'time_on_site' | 'conversation_started';
  enabled: boolean;
  match: 'all' | 'any';
  conditions: TriggerCondition[];
  actions: TriggerAction[];
  frequency: 'once_per_session' | 'once_per_visitor' | 'every_time';
  cooldownSeconds: number;
  afterSeconds: number;
  position: number;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface AutomationSchemaDto {
  fields: { field: string; type: 'string' | 'number' | 'boolean'; operators: string[] }[];
  placeholders: string[];
}
