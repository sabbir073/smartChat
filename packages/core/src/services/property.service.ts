import type { Database, Property } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
  Permission,
  type CursorPage,
  type TenantContext,
} from '@smartchat/types';
import type {
  AddDomainInput,
  CreatePropertyInput,
  ListPropertiesInput,
  UpdatePropertyInput,
} from '@smartchat/validation';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import {
  PropertyRepository,
  type PropertyWithDomains,
} from '../repositories/property.repository.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import type { EntitlementService } from './entitlement.service.js';

export interface PropertyServiceOptions {
  db: Database;
  entitlements: EntitlementService;
  widgetUrl: string;
  clock?: Clock;
}

export interface InstallationSnippet {
  publicId: string;
  loaderUrl: string;
  snippet: string;
  verified: boolean;
  lastRequestAt: Date | null;
}

export class PropertyService {
  private readonly clock: Clock;
  private readonly repo: PropertyRepository;
  private readonly audit: AuditRepository;

  constructor(private readonly options: PropertyServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.repo = new PropertyRepository(options.db);
    this.audit = new AuditRepository(options.db);
  }

  async list(context: TenantContext, query: ListPropertiesInput): Promise<CursorPage<Property>> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    return this.repo.list(context, query);
  }

  async get(context: TenantContext, propertyId: string): Promise<PropertyWithDomains> {
    requirePermission(context, Permission.PROPERTY_VIEW);
    requirePropertyAccess(context, propertyId);
    const property = await this.repo.findById(context, propertyId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    return property;
  }

  /**
   * Create a property and seed its allowed-domain list from the website URL.
   *
   * Seeding the domain is what makes "paste the snippet and it works" true on the first try:
   * without it, every new property would start by rejecting its own site.
   */
  async create(context: TenantContext, input: CreatePropertyInput): Promise<PropertyWithDomains> {
    requirePermission(context, Permission.PROPERTY_CREATE);

    const current = await this.repo.count(context);
    await this.options.entitlements.assertCanAdd(context, FeatureKey.MAX_PROPERTIES, current);

    const property = await this.repo.create(context, input);

    const host = safeHost(input.websiteUrl);
    if (host) {
      await this.repo.addDomain(context, property.id, host);
      if (!host.startsWith('www.')) {
        await this.repo.addDomain(context, property.id, `www.${host}`);
      }
    }

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.PROPERTY_CREATED,
      resourceType: 'property',
      resourceId: property.id,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { name: property.name, websiteUrl: property.websiteUrl },
    });

    const created = await this.repo.findById(context, property.id);
    if (!created) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return created;
  }

  async update(
    context: TenantContext,
    propertyId: string,
    input: UpdatePropertyInput,
  ): Promise<PropertyWithDomains> {
    requirePermission(context, Permission.PROPERTY_UPDATE);
    requirePropertyAccess(context, propertyId);

    const updated = await this.repo.update(context, propertyId, input);
    if (!updated) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.PROPERTY_UPDATED,
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { changed: Object.keys(input) },
    });

    const property = await this.repo.findById(context, propertyId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    return property;
  }

  async remove(context: TenantContext, propertyId: string): Promise<void> {
    requirePermission(context, Permission.PROPERTY_DELETE);
    requirePropertyAccess(context, propertyId);

    const deleted = await this.repo.softDelete(context, propertyId, this.clock.now());
    if (!deleted) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.PROPERTY_DELETED,
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  async addDomain(
    context: TenantContext,
    propertyId: string,
    input: AddDomainInput,
  ): Promise<PropertyWithDomains> {
    requirePermission(context, Permission.PROPERTY_UPDATE);
    requirePropertyAccess(context, propertyId);

    const property = await this.repo.findById(context, propertyId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    if (property.domains.some((domain) => domain.pattern === input.pattern)) {
      throw new AppError(ErrorCode.CONFLICT, 'That domain is already on the list');
    }

    await this.repo.addDomain(context, propertyId, input.pattern);
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.PROPERTY_DOMAIN_ADDED,
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { pattern: input.pattern },
    });

    return this.get(context, propertyId);
  }

  async removeDomain(
    context: TenantContext,
    propertyId: string,
    domainId: string,
  ): Promise<PropertyWithDomains> {
    requirePermission(context, Permission.PROPERTY_UPDATE);
    requirePropertyAccess(context, propertyId);

    const removed = await this.repo.removeDomain(context, propertyId, domainId);
    if (!removed) throw new AppError(ErrorCode.NOT_FOUND, 'Domain not found');

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.PROPERTY_DOMAIN_REMOVED,
      resourceType: 'property',
      resourceId: propertyId,
      ip: context.ip ?? null,
      metadata: { domainId },
    });

    return this.get(context, propertyId);
  }

  /**
   * The snippet the customer pastes before `</body>`.
   *
   * It contains only the public property id. No key, no account id, nothing that authorises
   * anything — every request carrying it is origin-checked server side.
   */
  async installation(context: TenantContext, propertyId: string): Promise<InstallationSnippet> {
    const property = await this.get(context, propertyId);
    const loaderUrl = `${this.options.widgetUrl.replace(/\/$/, '')}/v1/loader.js?p=${property.publicId}`;

    const snippet = `<!-- SmartChat -->
<script>
(function(w,d,s,u){
  w.SmartChat=w.SmartChat||function(){(w.SmartChat.q=w.SmartChat.q||[]).push(arguments)};
  var e=d.createElement(s);e.async=1;e.src=u;
  var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(e,f);
})(window,document,'script','${loaderUrl}');
</script>
<!-- /SmartChat -->`;

    return {
      publicId: property.publicId,
      loaderUrl,
      snippet,
      verified: property.installedAt !== null,
      lastRequestAt: property.lastWidgetRequestAt,
    };
  }
}

function safeHost(websiteUrl: string): string | null {
  try {
    return new URL(websiteUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
