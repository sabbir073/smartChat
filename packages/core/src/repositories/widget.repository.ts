import type { DatabaseOrTransaction, Widget } from '@smartchat/database';
import { dbNull, toJson } from '@smartchat/database';
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, type WidgetConfig } from '@smartchat/validation';
import type { TenantContext } from '@smartchat/types';
import { tenantScope } from './scope.js';

export interface ResolvedWidget {
  id: string;
  propertyId: string;
  version: number;
  publishedAt: Date | null;
  hasUnpublishedChanges: boolean;
  /** What visitors currently receive. */
  config: WidgetConfig;
  /** What the builder is editing. Equal to `config` when there are no pending edits. */
  draft: WidgetConfig;
}

function toResolved(widget: Widget): ResolvedWidget {
  const config = parseWidgetConfig(widget.config);
  return {
    id: widget.id,
    propertyId: widget.propertyId,
    version: widget.version,
    publishedAt: widget.publishedAt,
    hasUnpublishedChanges: widget.draftConfig !== null,
    config,
    draft: widget.draftConfig === null ? config : parseWidgetConfig(widget.draftConfig),
  };
}

export class WidgetRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  /**
   * Fetch the widget for a property, creating it with defaults if it does not exist yet.
   *
   * Lazy creation rather than creating one alongside every property: it keeps property creation a
   * single insert, and means a property created before widgets existed still works.
   */
  async ensureForProperty(
    context: TenantContext,
    propertyId: string,
  ): Promise<ResolvedWidget | null> {
    const property = await this.db.property.findFirst({
      where: { id: propertyId, ...tenantScope(context), deletedAt: null },
      select: { id: true },
    });
    if (!property) return null;

    const widget = await this.db.widget.upsert({
      where: { propertyId },
      update: {},
      create: {
        accountId: context.accountId,
        propertyId,
        config: toJson(DEFAULT_WIDGET_CONFIG as unknown as Record<string, unknown>),
        version: 1,
        publishedAt: new Date(),
      },
    });

    return toResolved(widget);
  }

  /**
   * The visitor-facing lookup: by the property's public id, with no tenant context because the
   * caller has no identity yet. Only the *published* config is ever returned here.
   */
  async findPublishedByPublicId(publicId: string): Promise<{
    accountId: string;
    propertyId: string;
    propertyName: string;
    enforceDomains: boolean;
    domains: { pattern: string; isWildcard: boolean }[];
    version: number;
    config: WidgetConfig;
  } | null> {
    const property = await this.db.property.findFirst({
      where: {
        publicId,
        deletedAt: null,
        status: 'active',
        account: { deletedAt: null, status: 'active' },
      },
      select: {
        id: true,
        accountId: true,
        name: true,
        enforceDomains: true,
        domains: { select: { pattern: true, isWildcard: true } },
        widget: { select: { config: true, version: true } },
      },
    });
    if (!property) return null;

    return {
      accountId: property.accountId,
      propertyId: property.id,
      propertyName: property.name,
      enforceDomains: property.enforceDomains,
      domains: property.domains,
      version: property.widget?.version ?? 1,
      // A property whose widget row does not exist yet still serves a working default, rather
      // than failing on the customer's site.
      config: parseWidgetConfig(property.widget?.config),
    };
  }

  async saveDraft(
    context: TenantContext,
    propertyId: string,
    draft: WidgetConfig,
  ): Promise<ResolvedWidget | null> {
    const result = await this.db.widget.updateMany({
      where: { propertyId, ...tenantScope(context) },
      data: { draftConfig: toJson(draft as unknown as Record<string, unknown>) },
    });
    if (result.count === 0) return null;
    const widget = await this.db.widget.findFirst({
      where: { propertyId, ...tenantScope(context) },
    });
    return widget ? toResolved(widget) : null;
  }

  /**
   * Promote the draft to live and bump the version.
   *
   * The version is what lets a cached loader notice its config is stale, so publishing takes
   * effect without the customer touching their snippet.
   */
  async publish(
    context: TenantContext,
    propertyId: string,
    now: Date,
  ): Promise<ResolvedWidget | null> {
    const widget = await this.db.widget.findFirst({
      where: { propertyId, ...tenantScope(context) },
    });
    if (!widget) return null;

    const draft = widget.draftConfig ?? widget.config;
    const updated = await this.db.widget.update({
      where: { id: widget.id },
      data: {
        config: draft as never,
        draftConfig: dbNull,
        version: { increment: 1 },
        publishedAt: now,
      },
    });
    return toResolved(updated);
  }

  /** Throw away unpublished edits. */
  async discardDraft(context: TenantContext, propertyId: string): Promise<ResolvedWidget | null> {
    const result = await this.db.widget.updateMany({
      where: { propertyId, ...tenantScope(context) },
      data: { draftConfig: dbNull },
    });
    if (result.count === 0) return null;
    const widget = await this.db.widget.findFirst({
      where: { propertyId, ...tenantScope(context) },
    });
    return widget ? toResolved(widget) : null;
  }
}
