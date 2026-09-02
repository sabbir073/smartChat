import type { Database, Shortcut } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
  Permission,
  type TenantContext,
} from '@smartchat/types';
import {
  createShortcutSchema,
  createTriggerSchema,
  type CreateShortcutInput,
  type CreateTriggerInput,
  type UpdateShortcutInput,
  type UpdateTriggerInput,
} from '@smartchat/validation';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import {
  ShortcutRepository,
  TriggerRepository,
  type ResolvedTrigger,
} from '../repositories/automation.repository.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import type { PlanGuard } from './plan-guard.js';

export interface AutomationServiceOptions {
  db: Database;
  /** Required, not optional: an entitlement nobody is forced to wire up is one nobody wires up. */
  plan: PlanGuard;
  clock?: Clock;
}

/**
 * Triggers and shortcuts as a customer manages them.
 *
 * Everything a rule can express is re-parsed by `createTriggerSchema` on the way in - including a
 * partial update, which is merged into the stored rule and validated whole. A trigger that would
 * only be invalid *in combination* with what is already stored is therefore refused, rather than
 * saved and left to fail at evaluation time.
 */
export class AutomationService {
  private readonly clock: Clock;
  private readonly triggers: TriggerRepository;
  private readonly shortcuts: ShortcutRepository;
  private readonly audit: AuditRepository;
  private readonly db: Database;
  private readonly plan: PlanGuard;

  constructor(options: AutomationServiceOptions) {
    this.db = options.db;
    this.plan = options.plan;
    this.clock = options.clock ?? systemClock;
    this.triggers = new TriggerRepository(options.db);
    this.shortcuts = new ShortcutRepository(options.db);
    this.audit = new AuditRepository(options.db);
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  async listTriggers(
    context: TenantContext,
    query: { propertyId?: string | undefined } = {},
  ): Promise<ResolvedTrigger[]> {
    requirePermission(context, Permission.TRIGGER_VIEW);
    if (query.propertyId) requirePropertyAccess(context, query.propertyId);
    return this.triggers.list(context, query);
  }

  async getTrigger(context: TenantContext, id: string): Promise<ResolvedTrigger> {
    requirePermission(context, Permission.TRIGGER_VIEW);
    const trigger = await this.triggers.findById(context, id);
    if (!trigger) throw new AppError(ErrorCode.TRIGGER_NOT_FOUND);
    // A restricted member must not be able to read a rule belonging to a website they cannot see.
    if (trigger.propertyId)
      requirePropertyAccess(context, trigger.propertyId, ErrorCode.TRIGGER_NOT_FOUND);
    return trigger;
  }

  async createTrigger(context: TenantContext, input: CreateTriggerInput): Promise<ResolvedTrigger> {
    requirePermission(context, Permission.TRIGGER_MANAGE);
    await this.plan.assertFeature(context, FeatureKey.FEATURE_TRIGGERS);
    await this.plan.assertCanAdd(context, FeatureKey.MAX_TRIGGERS);
    await this.assertPropertyUsable(context, input.propertyId);
    await this.assertDepartmentsExist(context, input);

    const trigger = await this.triggers.create({
      accountId: context.accountId,
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
      createdByMemberId: context.memberId ?? null,
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.TRIGGER_CREATED,
      resourceType: 'trigger',
      resourceId: trigger.id,
      ip: context.ip ?? null,
      metadata: { name: trigger.name, event: trigger.event },
    });

    return trigger;
  }

  async updateTrigger(
    context: TenantContext,
    id: string,
    input: UpdateTriggerInput,
  ): Promise<ResolvedTrigger> {
    requirePermission(context, Permission.TRIGGER_MANAGE);
    const existing = await this.getTrigger(context, id);

    /**
     * Validate the *result*, not the patch.
     *
     * Changing only the event can turn a perfectly valid rule into one that waits forever or tags
     * a conversation that will never exist. The merge below is what makes those refusals possible.
     */
    const merged = createTriggerSchema.parse({
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      propertyId: input.propertyId === undefined ? existing.propertyId : input.propertyId,
      event: input.event ?? existing.event,
      enabled: input.enabled ?? existing.enabled,
      match: input.match ?? existing.match,
      conditions: input.conditions ?? existing.conditions,
      actions: input.actions ?? existing.actions,
      frequency: input.frequency ?? existing.frequency,
      cooldownSeconds: input.cooldownSeconds ?? existing.cooldownSeconds,
      afterSeconds: input.afterSeconds ?? existing.afterSeconds,
      position: input.position ?? existing.position,
    });

    await this.assertPropertyUsable(context, merged.propertyId);
    await this.assertDepartmentsExist(context, merged);

    const updated = await this.triggers.update(context, id, {
      propertyId: merged.propertyId,
      name: merged.name,
      description: merged.description,
      event: merged.event,
      enabled: merged.enabled,
      match: merged.match,
      conditions: merged.conditions,
      actions: merged.actions,
      frequency: merged.frequency,
      cooldownSeconds: merged.cooldownSeconds,
      afterSeconds: merged.afterSeconds,
      position: merged.position,
    });
    if (!updated) throw new AppError(ErrorCode.TRIGGER_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.TRIGGER_UPDATED,
      resourceType: 'trigger',
      resourceId: id,
      ip: context.ip ?? null,
      metadata: { name: updated.name, enabled: updated.enabled },
    });

    return updated;
  }

  async deleteTrigger(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.TRIGGER_MANAGE);
    await this.getTrigger(context, id);

    const removed = await this.triggers.softDelete(context, id, this.clock.now());
    if (!removed) throw new AppError(ErrorCode.TRIGGER_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.TRIGGER_DELETED,
      resourceType: 'trigger',
      resourceId: id,
      ip: context.ip ?? null,
    });
  }

  /** A trigger scoped to a website the member cannot see would be invisible the moment it saved. */
  private async assertPropertyUsable(
    context: TenantContext,
    propertyId: string | null,
  ): Promise<void> {
    if (!propertyId) return;
    requirePropertyAccess(context, propertyId);
    const property = await this.db.property.findFirst({
      where: { accountId: context.accountId, id: propertyId, deletedAt: null },
      select: { id: true },
    });
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
  }

  /**
   * A routing action names a department, and a department id from another account would otherwise
   * be stored happily and fail silently every time the rule ran.
   */
  private async assertDepartmentsExist(
    context: TenantContext,
    input: { actions: CreateTriggerInput['actions'] },
  ): Promise<void> {
    const ids = input.actions
      .filter((action) => action.type === 'route_to_department')
      .map((action) => (action as { departmentId: string }).departmentId);
    if (ids.length === 0) return;

    const found = await this.db.department.count({
      where: { accountId: context.accountId, id: { in: ids }, deletedAt: null },
    });
    if (found !== new Set(ids).size) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That department does not exist');
    }
  }

  // -------------------------------------------------------------------------
  // Shortcuts
  // -------------------------------------------------------------------------

  async listShortcuts(context: TenantContext): Promise<Shortcut[]> {
    requirePermission(context, Permission.SHORTCUT_VIEW);
    return this.shortcuts.list(context);
  }

  async createShortcut(context: TenantContext, input: CreateShortcutInput): Promise<Shortcut> {
    requirePermission(context, Permission.SHORTCUT_MANAGE);
    await this.plan.assertCanAdd(context, FeatureKey.MAX_SHORTCUTS);
    const parsed = createShortcutSchema.parse(input);

    const created = await this.shortcuts.create({
      accountId: context.accountId,
      key: parsed.key,
      title: parsed.title,
      body: parsed.body,
      createdByMemberId: context.memberId ?? null,
    });
    if (!created)
      throw new AppError(ErrorCode.SHORTCUT_KEY_TAKEN, 'That shortcut is already taken');

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.SHORTCUT_CREATED,
      resourceType: 'shortcut',
      resourceId: created.id,
      ip: context.ip ?? null,
      metadata: { key: created.key },
    });

    return created;
  }

  async updateShortcut(
    context: TenantContext,
    id: string,
    input: UpdateShortcutInput,
  ): Promise<Shortcut> {
    requirePermission(context, Permission.SHORTCUT_MANAGE);

    const result = await this.shortcuts.update(context, id, {
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    if (result === 'conflict') {
      throw new AppError(ErrorCode.SHORTCUT_KEY_TAKEN, 'That shortcut is already taken');
    }
    if (!result) throw new AppError(ErrorCode.SHORTCUT_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.SHORTCUT_UPDATED,
      resourceType: 'shortcut',
      resourceId: id,
      ip: context.ip ?? null,
      metadata: { key: result.key },
    });

    return result;
  }

  async deleteShortcut(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.SHORTCUT_MANAGE);
    const removed = await this.shortcuts.softDelete(context, id, this.clock.now());
    if (!removed) throw new AppError(ErrorCode.SHORTCUT_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.SHORTCUT_DELETED,
      resourceType: 'shortcut',
      resourceId: id,
      ip: context.ip ?? null,
    });
  }

  /**
   * Count a use.
   *
   * Deliberately only `SHORTCUT_VIEW`: every agent who can insert one can count it, or the
   * ordering would reflect what administrators use rather than what the team uses.
   */
  async recordShortcutUse(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.SHORTCUT_VIEW);
    const counted = await this.shortcuts.bumpUsage(context, id);
    if (!counted) throw new AppError(ErrorCode.SHORTCUT_NOT_FOUND);
  }
}
