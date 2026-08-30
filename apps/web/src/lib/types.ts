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
  /** The customer's own mailbox for ticket replies. Null means "not monitored", and we say so. */
  supportEmail: string | null;
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

export interface ContactDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  customFields: Record<string, string>;
  visitorCount: number;
  propertyIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ContactFieldDto {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'url' | 'date' | 'select' | 'boolean';
  options: string[];
  position: number;
}

export interface ContactHistoryDto {
  contact: ContactDto;
  conversations: {
    id: string;
    propertyId: string;
    status: string;
    subject: string | null;
    channel: string;
    startedAt: string;
    lastMessageAt: string;
    messageCount: number;
  }[];
  files: {
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    conversationId: string;
    createdAt: string;
  }[];
}

export interface KbCategoryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
}

export interface KbArticleDto {
  id: string;
  propertyId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string;
  status: 'draft' | 'published';
  category: { id: string; name: string; slug: string } | null;
  publishedAt: string | null;
  viewCount: number;
  updatedAt: string;
}

/** The public help centre's shapes: no ids, no author, no counters. */
export interface PublicArticleSummary {
  slug: string;
  title: string;
  excerpt: string | null;
  category: { slug: string; name: string } | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface PublicArticleDto extends PublicArticleSummary {
  body: string;
}

export interface PublicKbIndexDto {
  property: { name: string };
  categories: { slug: string; name: string; description: string | null; articleCount: number }[];
  articles: PublicArticleSummary[];
}

export interface TicketDto {
  id: string;
  number: number;
  propertyId: string;
  contactId: string | null;
  conversationId: string | null;
  subject: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
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

export interface TicketMessageDto {
  id: string;
  seq: number;
  authorType: 'contact' | 'agent' | 'system';
  authorMemberId: string | null;
  visibility: 'public' | 'internal';
  body: string;
  createdAt: string;
}

export interface ReportDayPoint {
  day: string;
  conversationsStarted: number;
  conversationsClosed: number;
  messagesFromVisitors: number;
  messagesFromAgents: number;
  newVisitors: number;
  engagedVisitors: number;
  ticketsOpened: number;
  ticketsResolved: number;
  firstResponseCount: number;
  firstResponseSeconds: number;
  resolutionCount: number;
  resolutionSeconds: number;
}

export interface ReportOverviewDto {
  from: string;
  to: string;
  timezone: string;
  totals: {
    conversationsStarted: number;
    conversationsClosed: number;
    messagesFromVisitors: number;
    messagesFromAgents: number;
    newVisitors: number;
    engagedVisitors: number;
    ticketsOpened: number;
    ticketsResolved: number;
    firstResponseCount: number;
    resolutionCount: number;
    averageFirstResponseSeconds: number | null;
    averageResolutionSeconds: number | null;
  };
  series: ReportDayPoint[];
}

export interface ReportAgentDto {
  memberId: string;
  name: string;
  messagesSent: number;
  conversationsClosed: number;
  ticketRepliesSent: number;
  firstResponseCount: number;
  averageFirstResponseSeconds: number | null;
}

export interface ReportArticleDto {
  id: string;
  title: string;
  slug: string;
  status: string;
  viewCount: number;
}
