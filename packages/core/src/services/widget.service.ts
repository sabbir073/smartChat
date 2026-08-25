import type { Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import {
  parseWidgetConfig,
  widgetConfigSchema,
  type UpdateWidgetConfigInput,
  type WidgetConfig,
} from '@smartchat/validation';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import { WidgetRepository, type ResolvedWidget } from '../repositories/widget.repository.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Deep-merge a partial update into a config.
 *
 * Section-wise rather than field-wise arbitrary depth: the config has exactly one level of
 * sections, so this is complete, and a general deep merge would happily merge array contents,
 * which is wrong for the form-field lists (replacing them is the intended behaviour).
 */
export function mergeWidgetConfig(
  current: WidgetConfig,
  update: UpdateWidgetConfigInput,
): WidgetConfig {
  const merged = {
    appearance: { ...current.appearance, ...(update.appearance ?? {}) },
    placement: { ...current.placement, ...(update.placement ?? {}) },
    behaviour: { ...current.behaviour, ...(update.behaviour ?? {}) },
    content: { ...current.content, ...(update.content ?? {}) },
    forms: { ...current.forms, ...(update.forms ?? {}) },
  };
  // Re-parsed rather than cast: a partial update must still produce a config that satisfies the
  // full schema, or the widget would receive something it cannot render.
  return widgetConfigSchema.parse(merged);
}

export class WidgetService {
  private readonly clock: Clock;
  private readonly repo: WidgetRepository;
  private readonly audit: AuditRepository;

  constructor(db: Database, clock: Clock = systemClock) {
    this.clock = clock;
    this.repo = new WidgetRepository(db);
    this.audit = new AuditRepository(db);
  }

  async get(context: TenantContext, propertyId: string): Promise<ResolvedWidget> {
    requirePermission(context, Permission.WIDGET_VIEW);
    requirePropertyAccess(context, propertyId);
    const widget = await this.repo.ensureForProperty(context, propertyId);
    if (!widget) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    return widget;
  }

  /**
   * Save builder edits as a draft.
   *
   * Edits never reach a visitor until they are published, so a half-finished colour change is not
   * visible on the customer's live site while somebody is still working on it.
   */
  async saveDraft(
    context: TenantContext,
    propertyId: string,
    update: UpdateWidgetConfigInput,
  ): Promise<ResolvedWidget> {
    requirePermission(context, Permission.WIDGET_UPDATE);
    requirePropertyAccess(context, propertyId);

    const existing = await this.repo.ensureForProperty(context, propertyId);
    if (!existing) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    const draft = mergeWidgetConfig(existing.draft, update);
    const saved = await this.repo.saveDraft(context, propertyId, draft);
    if (!saved) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    return saved;
  }

  async publish(context: TenantContext, propertyId: string): Promise<ResolvedWidget> {
    requirePermission(context, Permission.WIDGET_UPDATE);
    requirePropertyAccess(context, propertyId);

    const published = await this.repo.publish(context, propertyId, this.clock.now());
    if (!published) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.WIDGET_UPDATED,
      resourceType: 'widget',
      resourceId: published.id,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { propertyId, version: published.version },
    });

    return published;
  }

  async discardDraft(context: TenantContext, propertyId: string): Promise<ResolvedWidget> {
    requirePermission(context, Permission.WIDGET_UPDATE);
    requirePropertyAccess(context, propertyId);
    const widget = await this.repo.discardDraft(context, propertyId);
    if (!widget) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    return widget;
  }

  /** Parse an arbitrary stored value into a usable config. Used by the preview endpoint. */
  static normalise(value: unknown): WidgetConfig {
    return parseWidgetConfig(value);
  }
}
