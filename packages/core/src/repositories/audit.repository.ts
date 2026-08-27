import type { AuditLog, DatabaseOrTransaction } from '@smartchat/database';
import { toJson } from '@smartchat/database';
import { type ActorType } from '@smartchat/database';
import { clampLimit, type CursorPage, type TenantContext } from '@smartchat/types';
import { afterCursor, encodeCursor, tenantScope } from './scope.js';

export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_PROFILE_UPDATED: 'user.profile_updated',
  SESSION_REVOKED: 'session.revoked',
  SESSIONS_REVOKED_ALL: 'session.revoked_all',
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_SUSPENDED: 'account.suspended',
  ACCOUNT_ACTIVATED: 'account.activated',
  MEMBER_INVITED: 'member.invited',
  MEMBER_UPDATED: 'member.updated',
  MEMBER_REMOVED: 'member.removed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  PROPERTY_CREATED: 'property.created',
  PROPERTY_UPDATED: 'property.updated',
  PROPERTY_DELETED: 'property.deleted',
  PROPERTY_DOMAIN_ADDED: 'property.domain_added',
  PROPERTY_DOMAIN_REMOVED: 'property.domain_removed',
  WIDGET_UPDATED: 'widget.updated',
  TRIGGER_CREATED: 'trigger.created',
  TRIGGER_UPDATED: 'trigger.updated',
  TRIGGER_DELETED: 'trigger.deleted',
  SHORTCUT_CREATED: 'shortcut.created',
  SHORTCUT_UPDATED: 'shortcut.updated',
  SHORTCUT_DELETED: 'shortcut.deleted',
  APIKEY_CREATED: 'apikey.created',
  APIKEY_REVOKED: 'apikey.revoked',
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  DATA_EXPORTED: 'data.exported',
  DATA_DELETED: 'data.deleted',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface RecordAuditInput {
  accountId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: AuditAction | string;
  resourceType: string;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Nothing in the application updates or deletes these rows — the only
 * removal path is the retention job, which drops whole periods rather than individual entries.
 */
export class AuditRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  async record(input: RecordAuditInput): Promise<void> {
    await this.db.auditLog.create({
      data: {
        accountId: input.accountId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: toJson(input.metadata),
      },
    });
  }

  async list(
    context: TenantContext,
    query: { cursor?: string | undefined; limit?: number | undefined; action?: string | undefined },
  ): Promise<CursorPage<AuditLog>> {
    const limit = clampLimit(query.limit);
    const rows = await this.db.auditLog.findMany({
      where: {
        ...tenantScope(context),
        ...(query.action ? { action: query.action } : {}),
        ...afterCursor(query.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);

    return {
      items,
      meta: {
        cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
    };
  }
}
