/** Closed value sets shared by the database, API, realtime layer and UI. */

export const AccountStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  PENDING_DELETION: 'pending_deletion',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const MemberRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  AGENT: 'agent',
} as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

export const MemberStatus = {
  INVITED: 'invited',
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];

export const AgentAvailability = {
  ONLINE: 'online',
  AWAY: 'away',
  OFFLINE: 'offline',
} as const;
export type AgentAvailability = (typeof AgentAvailability)[keyof typeof AgentAvailability];

export const ConversationStatus = {
  OPEN: 'open',
  PENDING: 'pending',
  CLOSED: 'closed',
} as const;
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const ConversationPriority = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;
export type ConversationPriority = (typeof ConversationPriority)[keyof typeof ConversationPriority];

export const ConversationChannel = {
  WIDGET: 'widget',
  OFFLINE_FORM: 'offline_form',
  EMAIL: 'email',
  API: 'api',
} as const;
export type ConversationChannel = (typeof ConversationChannel)[keyof typeof ConversationChannel];

export const SenderType = {
  VISITOR: 'visitor',
  AGENT: 'agent',
  SYSTEM: 'system',
  BOT: 'bot',
} as const;
export type SenderType = (typeof SenderType)[keyof typeof SenderType];

export const MessageType = {
  TEXT: 'text',
  FILE: 'file',
  IMAGE: 'image',
  SYSTEM: 'system',
  NOTE: 'note',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Client-side lifecycle of a message bubble. `pending` never exists server-side. */
export const MessageDeliveryState = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
} as const;
export type MessageDeliveryState = (typeof MessageDeliveryState)[keyof typeof MessageDeliveryState];

export const TicketStatus = {
  OPEN: 'open',
  PENDING: 'pending',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const ArticleStatus = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
} as const;
export type ArticleStatus = (typeof ArticleStatus)[keyof typeof ArticleStatus];

export const ArticleVisibility = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
} as const;
export type ArticleVisibility = (typeof ArticleVisibility)[keyof typeof ArticleVisibility];

export const WidgetPosition = {
  BOTTOM_RIGHT: 'bottom_right',
  BOTTOM_LEFT: 'bottom_left',
  TOP_RIGHT: 'top_right',
  TOP_LEFT: 'top_left',
} as const;
export type WidgetPosition = (typeof WidgetPosition)[keyof typeof WidgetPosition];

export const WidgetTheme = {
  LIGHT: 'light',
  DARK: 'dark',
  AUTO: 'auto',
} as const;
export type WidgetTheme = (typeof WidgetTheme)[keyof typeof WidgetTheme];

export const DeviceType = {
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  TABLET: 'tablet',
  BOT: 'bot',
  UNKNOWN: 'unknown',
} as const;
export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType];

export const FormFieldType = {
  TEXT: 'text',
  EMAIL: 'email',
  PHONE: 'phone',
  TEXTAREA: 'textarea',
  SELECT: 'select',
  CHECKBOX: 'checkbox',
} as const;
export type FormFieldType = (typeof FormFieldType)[keyof typeof FormFieldType];

export const FormFieldRequirement = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  DISABLED: 'disabled',
} as const;
export type FormFieldRequirement = (typeof FormFieldRequirement)[keyof typeof FormFieldRequirement];

/**
 * The events a webhook can subscribe to.
 *
 * This list was drafted in phase 0 with eight speculative entries - `message.created`,
 * `visitor.created`, `conversation.updated`, `ticket.updated` - none of which anything emitted.
 * Offering a subscription to an event that is never sent is worse than not offering it: the
 * integrator wires it up, tests nothing (because nothing arrives), and discovers months later that
 * the silence was the product rather than their code.
 *
 * So it is now exactly what is emitted, and it grows when an emitter does. A closed list with no
 * wildcard, for the same reason: `*` would silently start delivering a new event shape to an
 * endpoint that has never seen it, on the day we add one.
 */
export const WebhookEvent = {
  CONVERSATION_STARTED: 'conversation.started',
  CONVERSATION_CLOSED: 'conversation.closed',
  TICKET_CREATED: 'ticket.created',
  TICKET_REPLIED: 'ticket.replied',
  TICKET_STATUS_CHANGED: 'ticket.status_changed',
  /** Only ever sent by somebody pressing "send a test" in the dashboard. */
  PING: 'ping',
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

export const WEBHOOK_EVENT_VALUES: readonly WebhookEvent[] = Object.values(WebhookEvent);

/** Mirrors the database enum exactly. A status the column cannot hold is not a status. */
export const WebhookDeliveryStatus = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
} as const;
export type WebhookDeliveryStatus =
  (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export const BanScope = {
  VISITOR: 'visitor',
  IP: 'ip',
} as const;
export type BanScope = (typeof BanScope)[keyof typeof BanScope];
