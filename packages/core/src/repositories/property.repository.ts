import type { DatabaseOrTransaction, Property, PropertyDomain } from '@smartchat/database';
import { ID_PREFIX, newPublicId } from '@smartchat/database';
import { clampLimit, type CursorPage, type TenantContext } from '@smartchat/types';
import { afterCursor, encodeCursor, notDeleted, tenantScope } from './scope.js';

export interface CreatePropertyData {
  name: string;
  websiteUrl: string;
  timezone: string;
  locale: string;
}

export interface ListPropertiesQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  search?: string | undefined;
  status?: 'active' | 'paused' | undefined;
}

export type PropertyWithDomains = Property & { domains: PropertyDomain[] };

export class PropertyRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  /**
   * Property scoping is applied here as well as in the service layer: a restricted agent's
   * `propertyIds` narrows the id filter, so even a mistake upstream cannot widen the result set.
   */
  private scope(context: TenantContext) {
    const restriction =
      context.propertyIds && context.propertyIds.size > 0
        ? { id: { in: [...context.propertyIds] } }
        : {};
    return { ...tenantScope(context), ...notDeleted(), ...restriction };
  }

  async list(context: TenantContext, query: ListPropertiesQuery): Promise<CursorPage<Property>> {
    const limit = clampLimit(query.limit);
    const rows = await this.db.property.findMany({
      where: {
        ...this.scope(context),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { websiteUrl: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...afterCursor(query.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row tells us whether another page exists without a second count query.
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

  findById(context: TenantContext, propertyId: string): Promise<PropertyWithDomains | null> {
    return this.db.property.findFirst({
      where: { id: propertyId, ...this.scope(context) },
      include: { domains: { orderBy: { createdAt: 'asc' } } },
    });
  }


  async create(context: TenantContext, data: CreatePropertyData): Promise<Property> {
    return this.db.property.create({
      data: {
        accountId: context.accountId,
        publicId: newPublicId(ID_PREFIX.property),
        name: data.name,
        websiteUrl: data.websiteUrl,
        timezone: data.timezone,
        locale: data.locale,
      },
    });
  }

  /**
   * Scoped update: `updateMany` with the tenant predicate rather than `update` by id, so a
   * cross-tenant id updates zero rows instead of another account's property.
   */
  async update(
    context: TenantContext,
    propertyId: string,
    data: Partial<
      CreatePropertyData & {
        status: 'active' | 'paused';
        enforceDomains: boolean;
        supportEmail: string | null;
      }
    >,
  ): Promise<Property | null> {
    const result = await this.db.property.updateMany({
      where: { id: propertyId, ...this.scope(context) },
      data,
    });
    if (result.count === 0) return null;
    return this.db.property.findFirst({ where: { id: propertyId, ...this.scope(context) } });
  }

  async softDelete(context: TenantContext, propertyId: string, now: Date): Promise<boolean> {
    const result = await this.db.property.updateMany({
      where: { id: propertyId, ...this.scope(context) },
      data: { deletedAt: now, status: 'paused' },
    });
    return result.count === 1;
  }

  count(context: TenantContext): Promise<number> {
    return this.db.property.count({ where: { ...tenantScope(context), ...notDeleted() } });
  }

  async addDomain(
    context: TenantContext,
    propertyId: string,
    pattern: string,
  ): Promise<PropertyDomain | null> {
    const property = await this.db.property.findFirst({
      where: { id: propertyId, ...this.scope(context) },
      select: { id: true },
    });
    if (!property) return null;

    return this.db.propertyDomain.create({
      data: {
        accountId: context.accountId,
        propertyId,
        pattern,
        isWildcard: pattern.startsWith('*.'),
      },
    });
  }

  async removeDomain(
    context: TenantContext,
    propertyId: string,
    domainId: string,
  ): Promise<boolean> {
    const result = await this.db.propertyDomain.deleteMany({
      where: { id: domainId, propertyId, accountId: context.accountId },
    });
    return result.count === 1;
  }

  /**
   * Record that the widget was served for this property.
   *
   * `installedAt` is written only on the first successful request — it is the "installation
   * verified" signal in the dashboard, so it must record the first install, not the latest hit.
   */
  async recordWidgetRequest(propertyId: string, now: Date): Promise<void> {
    await this.db.property.updateMany({
      where: { id: propertyId },
      data: { lastWidgetRequestAt: now },
    });
    await this.db.property.updateMany({
      where: { id: propertyId, installedAt: null },
      data: { installedAt: now },
    });
  }
}
