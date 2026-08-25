/**
 * Permissions are data, not code branches.
 *
 * A route declares the permission it requires; a role is a named set of permissions stored in the
 * database. Roles can therefore be edited by an account owner without a deploy, and adding a
 * capability never means editing a chain of `if (role === 'admin')` checks.
 */
export const Permission = {
  // account
  ACCOUNT_VIEW: 'account:view',
  ACCOUNT_UPDATE: 'account:update',
  ACCOUNT_BILLING: 'account:billing',
  ACCOUNT_DELETE: 'account:delete',

  // members and roles
  MEMBER_VIEW: 'member:view',
  MEMBER_INVITE: 'member:invite',
  MEMBER_UPDATE: 'member:update',
  MEMBER_REMOVE: 'member:remove',
  ROLE_MANAGE: 'role:manage',

  // properties and widgets
  PROPERTY_VIEW: 'property:view',
  PROPERTY_CREATE: 'property:create',
  PROPERTY_UPDATE: 'property:update',
  PROPERTY_DELETE: 'property:delete',
  WIDGET_VIEW: 'widget:view',
  WIDGET_UPDATE: 'widget:update',

  // conversations
  CONVERSATION_VIEW_ASSIGNED: 'conversation:view_assigned',
  CONVERSATION_VIEW_ALL: 'conversation:view_all',
  CONVERSATION_REPLY: 'conversation:reply',
  CONVERSATION_ASSIGN: 'conversation:assign',
  CONVERSATION_TRANSFER: 'conversation:transfer',
  CONVERSATION_CLOSE: 'conversation:close',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_NOTE: 'conversation:note',
  CONVERSATION_TAG: 'conversation:tag',

  // visitors and contacts
  VISITOR_VIEW: 'visitor:view',
  CONTACT_VIEW: 'contact:view',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_DELETE: 'contact:delete',

  // automation
  TRIGGER_VIEW: 'trigger:view',
  TRIGGER_MANAGE: 'trigger:manage',
  SHORTCUT_VIEW: 'shortcut:view',
  SHORTCUT_MANAGE: 'shortcut:manage',

  // knowledge base
  KB_VIEW: 'kb:view',
  KB_MANAGE: 'kb:manage',

  // tickets
  TICKET_VIEW: 'ticket:view',
  TICKET_MANAGE: 'ticket:manage',

  // reporting
  REPORT_VIEW: 'report:view',

  // integrations
  WEBHOOK_MANAGE: 'webhook:manage',
  APIKEY_MANAGE: 'apikey:manage',

  // audit
  AUDIT_VIEW: 'audit:view',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Defaults applied when an account is created. They are copied into editable role rows, so an
 * account owner can diverge from these without affecting anyone else.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  owner: ALL_PERMISSIONS,

  admin: ALL_PERMISSIONS.filter(
    (p) => p !== Permission.ACCOUNT_DELETE && p !== Permission.ACCOUNT_BILLING,
  ),

  manager: [
    Permission.ACCOUNT_VIEW,
    Permission.MEMBER_VIEW,
    Permission.PROPERTY_VIEW,
    Permission.WIDGET_VIEW,
    Permission.WIDGET_UPDATE,
    Permission.CONVERSATION_VIEW_ALL,
    Permission.CONVERSATION_REPLY,
    Permission.CONVERSATION_ASSIGN,
    Permission.CONVERSATION_TRANSFER,
    Permission.CONVERSATION_CLOSE,
    Permission.CONVERSATION_NOTE,
    Permission.CONVERSATION_TAG,
    Permission.VISITOR_VIEW,
    Permission.CONTACT_VIEW,
    Permission.CONTACT_UPDATE,
    Permission.TRIGGER_VIEW,
    Permission.TRIGGER_MANAGE,
    Permission.SHORTCUT_VIEW,
    Permission.SHORTCUT_MANAGE,
    Permission.KB_VIEW,
    Permission.KB_MANAGE,
    Permission.TICKET_VIEW,
    Permission.TICKET_MANAGE,
    Permission.REPORT_VIEW,
  ],

  agent: [
    Permission.PROPERTY_VIEW,
    Permission.CONVERSATION_VIEW_ASSIGNED,
    Permission.CONVERSATION_REPLY,
    Permission.CONVERSATION_CLOSE,
    Permission.CONVERSATION_NOTE,
    Permission.CONVERSATION_TAG,
    Permission.VISITOR_VIEW,
    Permission.CONTACT_VIEW,
    Permission.SHORTCUT_VIEW,
    Permission.KB_VIEW,
    Permission.TICKET_VIEW,
  ],
};

/** Platform-level capabilities. Deliberately a separate space from tenant permissions. */
export const PlatformPermission = {
  ACCOUNT_VIEW: 'platform:account:view',
  ACCOUNT_SUSPEND: 'platform:account:suspend',
  PLAN_MANAGE: 'platform:plan:manage',
  USAGE_VIEW: 'platform:usage:view',
  SYSTEM_VIEW: 'platform:system:view',
  FEATURE_FLAG_MANAGE: 'platform:flag:manage',
  AUDIT_VIEW: 'platform:audit:view',
  SETTINGS_MANAGE: 'platform:settings:manage',
} as const;
export type PlatformPermission = (typeof PlatformPermission)[keyof typeof PlatformPermission];
