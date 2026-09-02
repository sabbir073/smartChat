/** Realtime event names. Shared verbatim by the gateway, the dashboard and the widget panel. */

export const VisitorClientEvent = {
  CONVERSATION_START: 'conversation:start',
  /** The visitor ends their own chat. There is no visitor-facing reopen; see ADR-027. */
  CONVERSATION_CLOSE: 'conversation:close',
  MESSAGE_SEND: 'message:send',
  MESSAGE_READ: 'message:read',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  PAGE_VIEW: 'page:view',
  SYNC_SINCE: 'sync:since',
} as const;
export type VisitorClientEvent = (typeof VisitorClientEvent)[keyof typeof VisitorClientEvent];

export const AgentClientEvent = {
  INBOX_SUBSCRIBE: 'inbox:subscribe',
  INBOX_UNSUBSCRIBE: 'inbox:unsubscribe',
  CONVERSATION_OPEN: 'conversation:open',
  CONVERSATION_CLOSE_VIEW: 'conversation:close_view',
  MESSAGE_SEND: 'message:send',
  NOTE_ADD: 'note:add',
  MESSAGE_READ: 'message:read',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  PRESENCE_SET: 'presence:set',
  SYNC_SINCE: 'sync:since',
} as const;
export type AgentClientEvent = (typeof AgentClientEvent)[keyof typeof AgentClientEvent];

export const ServerEvent = {
  MESSAGE_NEW: 'message:new',
  CONVERSATION_CREATED: 'conversation:created',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_ASSIGNED: 'conversation:assigned',
  CONVERSATION_CLOSED: 'conversation:closed',
  TYPING: 'typing',
  PRESENCE_AGENT: 'presence:agent',
  PRESENCE_VISITOR: 'presence:visitor',
  /**
   * Whether anybody is there to answer, sent to visitors.
   *
   * Distinct from PRESENCE_AGENT, which names a member and belongs to the agent namespace. A
   * visitor is told one boolean and never which people are online.
   */
  AGENTS_AVAILABLE: 'presence:agents_available',
} as const;
export type ServerEvent = (typeof ServerEvent)[keyof typeof ServerEvent];

/** Redis pub/sub channels used to fan events between gateway instances and the worker. */
export const RedisChannel = {
  CONVERSATION_EVENTS: 'smartchat:events:conversation',
  PRESENCE_EVENTS: 'smartchat:events:presence',
  SYSTEM_EVENTS: 'smartchat:events:system',
} as const;
export type RedisChannel = (typeof RedisChannel)[keyof typeof RedisChannel];

/** Room name builders. Clients never supply a room name; these are the only source. */
export const room = {
  conversation: (conversationId: string) => `conv:${conversationId}`,
  property: (propertyId: string) => `prop:${propertyId}`,
  account: (accountId: string) => `account:${accountId}`,
  agent: (userId: string) => `agent:${userId}`,
  visitor: (visitorId: string) => `visitor:${visitorId}`,
} as const;

/** Redis key builders for ephemeral state. Centralised so TTL policy stays consistent. */
export const presenceKey = {
  agent: (accountId: string, userId: string) => `presence:agent:${accountId}:${userId}`,
  agentSet: (accountId: string) => `presence:agents:${accountId}`,
  visitor: (propertyId: string, visitorId: string) => `presence:visitor:${propertyId}:${visitorId}`,
  visitorSet: (propertyId: string) => `presence:visitors:${propertyId}`,
  typing: (conversationId: string, actorId: string) => `typing:${conversationId}:${actorId}`,
  ticket: (ticketId: string) => `rt:ticket:${ticketId}`,
} as const;

export const PRESENCE_TTL_SECONDS = 45;
export const PRESENCE_HEARTBEAT_SECONDS = 20;
export const TYPING_TTL_SECONDS = 6;
export const REALTIME_TICKET_TTL_SECONDS = 60;
