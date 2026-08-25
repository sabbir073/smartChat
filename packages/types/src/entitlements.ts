/**
 * Plan limits are data, never constants in application code.
 *
 * Code asks the entitlement service "what is this account's limit for X?"; the answer comes from
 * the plan attached to the account. Changing a plan is therefore a database change, not a deploy,
 * and a custom limit for one customer needs no special case anywhere.
 */
export const FeatureKey = {
  MAX_PROPERTIES: 'max_properties',
  MAX_AGENTS: 'max_agents',
  MAX_MONTHLY_CONVERSATIONS: 'max_monthly_conversations',
  MAX_STORAGE_BYTES: 'max_storage_bytes',
  MAX_KB_ARTICLES: 'max_kb_articles',
  MAX_WEBHOOKS: 'max_webhooks',
  MAX_API_REQUESTS_PER_DAY: 'max_api_requests_per_day',
  MAX_TRIGGERS: 'max_triggers',
  MAX_SHORTCUTS: 'max_shortcuts',
  MAX_CONVERSATION_HISTORY_DAYS: 'max_conversation_history_days',

  FEATURE_KNOWLEDGE_BASE: 'feature_knowledge_base',
  FEATURE_TICKETS: 'feature_tickets',
  FEATURE_TRIGGERS: 'feature_triggers',
  FEATURE_WEBHOOKS: 'feature_webhooks',
  FEATURE_PUBLIC_API: 'feature_public_api',
  FEATURE_REMOVE_BRANDING: 'feature_remove_branding',
  FEATURE_CUSTOM_ROLES: 'feature_custom_roles',
  FEATURE_FILE_ATTACHMENTS: 'feature_file_attachments',
} as const;
export type FeatureKey = (typeof FeatureKey)[keyof typeof FeatureKey];

/** Human labels used in upgrade prompts, so limit messages never read like error codes. */
export const FEATURE_LABEL: Readonly<Record<FeatureKey, string>> = {
  max_properties: 'websites',
  max_agents: 'team members',
  max_monthly_conversations: 'conversations this month',
  max_storage_bytes: 'file storage',
  max_kb_articles: 'knowledge base articles',
  max_webhooks: 'webhooks',
  max_api_requests_per_day: 'API requests per day',
  max_triggers: 'triggers',
  max_shortcuts: 'shortcuts',
  max_conversation_history_days: 'days of conversation history',
  feature_knowledge_base: 'the knowledge base',
  feature_tickets: 'tickets',
  feature_triggers: 'triggers',
  feature_webhooks: 'webhooks',
  feature_public_api: 'the public API',
  feature_remove_branding: 'branding removal',
  feature_custom_roles: 'custom roles',
  feature_file_attachments: 'file attachments',
};
