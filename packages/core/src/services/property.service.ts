import type { Database, Property } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
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
import type { OutboundFetch } from '../integrations/outbound.js';

export interface PropertyServiceOptions {
  db: Database;
  widgetUrl: string;
  /**
   * How the installation check fetches the customer's own site.
   *
   * The DNS-pinned outbound client, the same one webhook delivery uses — this is a request to a
   * URL the customer typed, which is the definition of a server-side request forgery primitive if
   * it is made with a bare `fetch`.
   *
   * Optional: without it the check falls back to "has the widget called us", which is the
   * authoritative signal anyway and needs no outbound request at all.
   */
  fetchSite?: OutboundFetch;
  clock?: Clock;
}

export interface InstallationSnippet {
  publicId: string;
  loaderUrl: string;
  snippet: string;
  verified: boolean;
  lastRequestAt: Date | null;
}

/**
 * What a check actually found, rather than a bare yes or no.
 *
 * The two kinds of evidence are genuinely different and a customer staring at "not installed"
 * deserves to know which one is missing. `widget_request` means a real browser on their site
 * loaded the widget — proof, and the only thing that can confirm a snippet injected by a tag
 * manager. `snippet_found` means the loader is in the HTML this server was served, which confirms
 * a paste before anybody has visited the page.
 */
export type InstallationEvidence = 'widget_request' | 'snippet_found';

export interface InstallationCheck {
  verified: boolean;
  evidence: InstallationEvidence | null;
  /** The page that was fetched, when one was. */
  checkedUrl: string | null;
  lastRequestAt: Date | null;
  /** One sentence a person can act on. Never a stack trace, never a URL we were refused. */
  detail: string;
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
  /**
   * Check the installation now, instead of waiting for somebody to visit the site.
   *
   * Before this, "installed" could only become true as a side effect of a real visitor loading the
   * widget. Paste the snippet, come back to the dashboard, and it still said Awaiting installation
   * — with no way to tell whether the paste was wrong or simply nobody had been to the page yet.
   * Those are very different problems and the screen gave the same answer to both.
   *
   * Two pieces of evidence, in order of strength:
   *
   *  1. The widget has called us. That is proof, and the only thing that can see a snippet a tag
   *     manager injects at runtime, which never appears in the HTML.
   *  2. The loader is in the page's HTML. That confirms a correct paste before anybody has
   *     visited, and is what makes this button worth pressing at all.
   *
   * A failure to fetch is reported as a failure to fetch. It is emphatically not evidence of a
   * missing snippet — a site behind a login, a firewall, or Cloudflare is not a misinstalled one,
   * and saying so would send people to re-paste a snippet that was already correct.
   */
  async verifyInstallation(context: TenantContext, propertyId: string): Promise<InstallationCheck> {
    const property = await this.get(context, propertyId);
    const now = this.clock.now();

    const recentlyRequested =
      property.lastWidgetRequestAt !== null &&
      now.getTime() - property.lastWidgetRequestAt.getTime() <= INSTALL_REQUEST_WINDOW_MS;

    if (recentlyRequested) {
      return {
        verified: true,
        evidence: 'widget_request',
        checkedUrl: null,
        lastRequestAt: property.lastWidgetRequestAt,
        detail: 'The widget on your site loaded recently, so the snippet is working.',
      };
    }

    const found = await this.findSnippetOnSite(property.websiteUrl, property.publicId);

    if (found.found) {
      // The snippet is on the page. That is an installation, whether or not a visitor has been
      // yet, so it is recorded as one - the badge should not go back to Awaiting on reload.
      await this.repo.recordWidgetRequest(propertyId, now);
      return {
        verified: true,
        evidence: 'snippet_found',
        checkedUrl: found.url,
        lastRequestAt: property.lastWidgetRequestAt,
        detail: 'Found the snippet on your site.',
      };
    }

    return {
      verified: property.installedAt !== null,
      evidence: null,
      checkedUrl: found.url,
      lastRequestAt: property.lastWidgetRequestAt,
      detail: found.detail,
    };
  }

  /**
   * Fetch the customer's home page and look for their own loader in it.
   *
   * Bounded on purpose: one request, no redirects followed by us beyond what the client allows, a
   * short timeout, and only the first slice of the body read. This runs on demand from a
   * dashboard button, and a customer's home page is not a resource this server should be willing
   * to spend much on.
   */
  private async findSnippetOnSite(
    websiteUrl: string,
    publicId: string,
  ): Promise<{ found: boolean; url: string | null; detail: string }> {
    if (!this.options.fetchSite) {
      return {
        found: false,
        url: null,
        detail:
          'No request from your site yet. Open a page where you pasted the snippet, then check again.',
      };
    }

    let url: string;
    try {
      url = new URL(websiteUrl).toString();
    } catch {
      return {
        found: false,
        url: null,
        detail: 'This property has no valid website address to check. Add one in its settings.',
      };
    }

    try {
      const response = await this.options.fetchSite(url, {
        method: 'GET',
        headers: { accept: 'text/html', 'user-agent': 'SmartChat-Installation-Check' },
        body: '',
        timeoutMs: INSTALL_CHECK_TIMEOUT_MS,
      });

      if (response.status >= 400) {
        return {
          found: false,
          url,
          detail: `Your site answered ${response.status} when we looked, so we could not read the page. If the snippet is in place, open the page yourself and check again.`,
        };
      }

      const html = (await response.text()).slice(0, INSTALL_CHECK_MAX_BYTES);
      // The public id is the part of the snippet that is unique to this property, and it survives
      // minification, a different quote style, and a self-hosted copy of the loader.
      const found = html.includes(publicId);

      return {
        found,
        url,
        detail: found
          ? 'Found the snippet on your site.'
          : 'We read your page but did not find the snippet. If you add it with a tag manager it will not appear in the HTML - open the page in a browser and check again.',
      };
    } catch {
      // Deliberately not the underlying error: it names addresses and internals, and none of it
      // helps somebody decide what to do next.
      return {
        found: false,
        url,
        detail:
          'We could not reach your site to check. Open a page where you pasted the snippet, then check again.',
      };
    }
  }
}

/** How recently the widget must have called for a live request to count as proof. */
const INSTALL_REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INSTALL_CHECK_TIMEOUT_MS = 8000;
const INSTALL_CHECK_MAX_BYTES = 512 * 1024;

function safeHost(websiteUrl: string): string | null {
  try {
    return new URL(websiteUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
