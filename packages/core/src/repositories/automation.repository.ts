import type {
  Database,
  DatabaseOrTransaction,
  Shortcut,
  Trigger,
  TriggerFiring,
} from '@smartchat/database';
import { isUniqueViolation } from '@smartchat/database';
import type { TenantContext } from '@smartchat/types';
import {
  storedActionsSchema,
  storedConditionsSchema,
  type TriggerAction,
  type TriggerCondition,
  type TriggerEventName,
} from '@smartchat/validation';
import { notDeleted, tenantScope } from './scope.js';

/**
 * A trigger with its JSON columns already parsed.
 *
 * Nothing outside this module ever sees the raw `Json` - a rule shape that no longer validates is
 * turned into an empty list here, at the boundary, so the engine can never be handed something it
 * would half-understand.
 */
export type ResolvedTrigger = Omit<Trigger, 'conditions' | 'actions'> & {
  conditions: TriggerCondition[];
  actions: TriggerAction[];
};

export function resolveTrigger(row: Trigger): ResolvedTrigger {
  return {
    ...row,
    conditions: storedConditionsSchema.parse(row.conditions),
    actions: storedActionsSchema.parse(row.actions),
  };
}

export interface CreateTriggerRow {
  accountId: string;
  propertyId: string | null;
  name: string;
  description: string | null;
  event: TriggerEventName;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: TriggerCondition[];
  actions: TriggerAction[];
  frequency: 'once_per_session' | 'once_per_visitor' | 'every_time';
  cooldownSeconds: number;
  afterSeconds: number;
  position: number;
  createdByMemberId: string | null;
}

export class TriggerRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  async list(
    context: TenantContext,
    query: { propertyId?: string | null | undefined } = {},
  ): Promise<ResolvedTrigger[]> {
    const rows = await this.db.trigger.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        // A restricted member sees the triggers of the websites they work on, plus the
        // account-wide ones that also apply to those websites.
        ...(context.propertyIds && context.propertyIds.size > 0
          ? { OR: [{ propertyId: null }, { propertyId: { in: [...context.propertyIds] } }] }
          : {}),
        ...(query.propertyId === undefined
          ? {}
          : query.propertyId === null
            ? { propertyId: null }
            : { propertyId: query.propertyId }),
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(resolveTrigger);
  }

  async findById(context: TenantContext, id: string): Promise<ResolvedTrigger | null> {
    const row = await this.db.trigger.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
    });
    return row ? resolveTrigger(row) : null;
  }

  async create(input: CreateTriggerRow): Promise<ResolvedTrigger> {
    const row = await this.db.trigger.create({
      data: {
        accountId: input.accountId,
        propertyId: input.propertyId,
        name: input.name,
        description: input.description,
        event: input.event,
        enabled: input.enabled,
        match: input.match,
        conditions: input.conditions,
        actions: input.actions,
        frequency: input.frequency,
        cooldownSeconds: input.cooldownSeconds,
        afterSeconds: input.afterSeconds,
        position: input.position,
        createdByMemberId: input.createdByMemberId,
      },
    });
    return resolveTrigger(row);
  }

  async update(
    context: TenantContext,
    id: string,
    data: Partial<Omit<CreateTriggerRow, 'accountId' | 'createdByMemberId'>>,
  ): Promise<ResolvedTrigger | null> {
    const changed = await this.db.trigger.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data,
    });
    if (changed.count === 0) return null;
    return this.findById(context, id);
  }

  async softDelete(context: TenantContext, id: string, now: Date): Promise<boolean> {
    const changed = await this.db.trigger.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data: { deletedAt: now, enabled: false },
    });
    return changed.count > 0;
  }

  /**
   * The gateway's read: every enabled rule that could fire for this visitor, in order.
   *
   * Not `TenantContext`-scoped, because the caller is a visitor socket rather than a member -
   * the account and property come from the signed ticket the socket authenticated with.
   */
  async listForEvent(
    accountId: string,
    propertyId: string,
    event: TriggerEventName,
  ): Promise<ResolvedTrigger[]> {
    const rows = await this.db.trigger.findMany({
      where: {
        accountId,
        event,
        enabled: true,
        deletedAt: null,
        OR: [{ propertyId: null }, { propertyId }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(resolveTrigger);
  }

  /**
   * Claim the right to fire.
   *
   * Returns null when this trigger has already fired for this key. The unique index is what
   * decides, not a preceding read: two gateway processes holding sockets for the same visitor
   * will both try, and exactly one will win.
   */
  async claimFiring(input: {
    accountId: string;
    triggerId: string;
    propertyId: string;
    visitorId: string;
    sessionId: string | null;
    dedupeKey: string | null;
    firedAt: Date;
  }): Promise<TriggerFiring | null> {
    try {
      return await this.db.triggerFiring.create({
        data: {
          accountId: input.accountId,
          triggerId: input.triggerId,
          propertyId: input.propertyId,
          visitorId: input.visitorId,
          sessionId: input.sessionId,
          dedupeKey: input.dedupeKey,
          firedAt: input.firedAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dedupe_key')) return null;
      throw error;
    }
  }

  /** Attach the conversation the actions ended up applying to. */
  async attachConversation(firingId: string, conversationId: string): Promise<void> {
    await this.db.triggerFiring.update({
      where: { id: firingId },
      data: { conversationId },
    });
  }

  async deleteFiring(firingId: string): Promise<void> {
    await this.db.triggerFiring.delete({ where: { id: firingId } }).catch(() => undefined);
  }

  /** The most recent firing for one visitor, which is what a cooldown is measured against. */
  async lastFiredAt(accountId: string, triggerId: string, visitorId: string): Promise<Date | null> {
    const row = await this.db.triggerFiring.findFirst({
      where: { accountId, triggerId, visitorId },
      orderBy: { firedAt: 'desc' },
      select: { firedAt: true },
    });
    return row?.firedAt ?? null;
  }

  async recordFired(accountId: string, triggerId: string, now: Date): Promise<void> {
    await this.db.trigger.updateMany({
      where: { accountId, id: triggerId },
      data: { fireCount: { increment: 1 }, lastFiredAt: now },
    });
  }

  async countFirings(context: TenantContext, triggerId: string): Promise<number> {
    return this.db.triggerFiring.count({
      where: { ...tenantScope(context), triggerId },
    });
  }
}

export class ShortcutRepository {
  constructor(private readonly db: Database) {}

  list(context: TenantContext): Promise<Shortcut[]> {
    return this.db.shortcut.findMany({
      where: { ...tenantScope(context), ...notDeleted() },
      orderBy: [{ usageCount: 'desc' }, { key: 'asc' }],
    });
  }

  findById(context: TenantContext, id: string): Promise<Shortcut | null> {
    return this.db.shortcut.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
    });
  }

  async create(input: {
    accountId: string;
    key: string;
    title: string;
    body: string;
    createdByMemberId: string | null;
  }): Promise<Shortcut | null> {
    try {
      return await this.db.shortcut.create({ data: input });
    } catch (error) {
      // A key that is already taken is a conflict for the caller to report, not a 500.
      if (isUniqueViolation(error, 'key')) return null;
      throw error;
    }
  }

  async update(
    context: TenantContext,
    id: string,
    data: { key?: string; title?: string; body?: string },
  ): Promise<Shortcut | null | 'conflict'> {
    try {
      const changed = await this.db.shortcut.updateMany({
        where: { ...tenantScope(context), ...notDeleted(), id },
        data,
      });
      if (changed.count === 0) return null;
      return this.findById(context, id);
    } catch (error) {
      if (isUniqueViolation(error, 'key')) return 'conflict';
      throw error;
    }
  }

  async softDelete(context: TenantContext, id: string, now: Date): Promise<boolean> {
    const changed = await this.db.shortcut.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data: { deletedAt: now },
    });
    return changed.count > 0;
  }

  /**
   * Count one use.
   *
   * Scoped by account as well as id, so a member of another account cannot inflate somebody
   * else's ordering by guessing an id.
   */
  async bumpUsage(context: TenantContext, id: string): Promise<boolean> {
    const changed = await this.db.shortcut.updateMany({
      where: { ...tenantScope(context), ...notDeleted(), id },
      data: { usageCount: { increment: 1 } },
    });
    return changed.count > 0;
  }
}
