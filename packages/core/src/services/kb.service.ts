import type { Database, KbArticle, KbCategory } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  AppError,
  ErrorCode,
  FeatureKey,
  Permission,
  type TenantContext,
} from '@smartchat/types';
import {
  slugifyTitle,
  type CreateArticleInput,
  type CreateCategoryInput,
  type ListArticlesInput,
  type PublicKbSearchInput,
  type UpdateArticleInput,
  type UpdateCategoryInput,
} from '@smartchat/validation';
import { AuditRepository } from '../repositories/audit.repository.js';
import { WidgetRepository } from '../repositories/widget.repository.js';
import { notDeleted, tenantScope } from '../repositories/scope.js';
import { requirePermission, requirePropertyAccess } from '../tenancy/context.js';
import { assertPropertyInAccount } from '../tenancy/property-access.js';
import { systemClock, type Clock } from '../time.js';
import type { PlanGuard } from './plan-guard.js';

export type ArticleWithCategory = KbArticle & { category: KbCategory | null };

export interface PublicArticle {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  category: { slug: string; name: string } | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface KbServiceOptions {
  db: Database;
  /** Required, not optional: an entitlement nobody is forced to wire up is one nobody wires up. */
  plan: PlanGuard;
  /**
   * The platform kill switch for the public help centre. Optional so tests need not wire one.
   * Checked in `resolvePublic`, which every public read passes through; the authenticated side is
   * deliberately unaffected, so an account can still edit while its public pages are paused.
   */
  flags?: { assertEnabled(flag: 'public_help_centre', accountId?: string): Promise<void> };
  clock?: Clock;
}

/**
 * The help centre.
 *
 * Two audiences with very different rights, and the split is the whole design. An agent works
 * through `TenantContext` and can see drafts. The public surface has no identity at all: it is
 * keyed by a property's public id, it only ever reads `published` rows, and it returns a shape
 * that contains nothing internal - no ids, no author, no counters.
 */
export class KbService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;
  private readonly widgets: WidgetRepository;

  constructor(private readonly options: KbServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
    this.widgets = new WidgetRepository(options.db);
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  async listCategories(context: TenantContext, propertyId: string): Promise<KbCategory[]> {
    requirePermission(context, Permission.KB_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    return this.options.db.kbCategory.findMany({
      where: { ...tenantScope(context), ...notDeleted(), propertyId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(
    context: TenantContext,
    propertyId: string,
    input: CreateCategoryInput,
  ): Promise<KbCategory> {
    requirePermission(context, Permission.KB_MANAGE);
    await assertPropertyInAccount(this.options.db, context, propertyId);
    const slug = input.slug ?? slugifyTitle(input.name);
    await this.assertCategorySlugFree(propertyId, slug, null);

    return this.options.db.kbCategory.create({
      data: {
        accountId: context.accountId,
        propertyId,
        name: input.name,
        slug,
        description: input.description,
        position: input.position,
      },
    });
  }

  async updateCategory(
    context: TenantContext,
    id: string,
    input: UpdateCategoryInput,
  ): Promise<KbCategory> {
    requirePermission(context, Permission.KB_MANAGE);
    const existing = await this.options.db.kbCategory.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);
    requirePropertyAccess(context, existing.propertyId);
    if (input.slug) await this.assertCategorySlugFree(existing.propertyId, input.slug, id);

    return this.options.db.kbCategory.update({ where: { id }, data: input });
  }

  /**
   * Remove a section, keeping its articles.
   *
   * Soft, and the articles fall back to having no category rather than disappearing with it.
   * Deleting a folder should not delete the writing in it - that is a mistake nobody expects to be
   * unrecoverable.
   */
  async deleteCategory(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.KB_MANAGE);
    const existing = await this.options.db.kbCategory.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND);
    requirePropertyAccess(context, existing.propertyId);

    await this.options.db.$transaction([
      this.options.db.kbArticle.updateMany({
        where: { accountId: context.accountId, categoryId: id },
        data: { categoryId: null },
      }),
      this.options.db.kbCategory.update({
        where: { id },
        data: { deletedAt: this.clock.now() },
      }),
    ]);
  }

  private async assertCategorySlugFree(
    propertyId: string,
    slug: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.options.db.kbCategory.findFirst({
      where: { propertyId, slug, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new AppError(ErrorCode.DUPLICATE_SLUG, 'That address is already in use');
  }

  // ---------------------------------------------------------------------------
  // Articles, for the people who write them
  // ---------------------------------------------------------------------------

  async listArticles(
    context: TenantContext,
    propertyId: string,
    query: ListArticlesInput,
  ): Promise<ArticleWithCategory[]> {
    requirePermission(context, Permission.KB_VIEW);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    return this.options.db.kbArticle.findMany({
      where: {
        ...tenantScope(context),
        ...notDeleted(),
        propertyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' } },
                { body: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { category: true },
      orderBy: [{ updatedAt: 'desc' }],
      take: query.limit,
    });
  }

  async getArticle(context: TenantContext, id: string): Promise<ArticleWithCategory> {
    requirePermission(context, Permission.KB_VIEW);
    const article = await this.options.db.kbArticle.findFirst({
      where: { ...tenantScope(context), ...notDeleted(), id },
      include: { category: true },
    });
    if (!article) throw new AppError(ErrorCode.ARTICLE_NOT_FOUND);
    requirePropertyAccess(context, article.propertyId, ErrorCode.ARTICLE_NOT_FOUND);
    return article;
  }

  async createArticle(
    context: TenantContext,
    propertyId: string,
    input: CreateArticleInput,
  ): Promise<ArticleWithCategory> {
    requirePermission(context, Permission.KB_MANAGE);
    await this.options.plan.assertFeature(context, FeatureKey.FEATURE_KNOWLEDGE_BASE);
    await this.options.plan.assertCanAdd(context, FeatureKey.MAX_KB_ARTICLES);
    await assertPropertyInAccount(this.options.db, context, propertyId);

    const slug = input.slug ?? slugifyTitle(input.title);
    await this.assertArticleSlugFree(propertyId, slug, null);
    if (input.categoryId) await this.assertCategoryBelongs(context, propertyId, input.categoryId);

    const now = this.clock.now();
    const article = await this.options.db.kbArticle.create({
      data: {
        accountId: context.accountId,
        propertyId,
        categoryId: input.categoryId,
        slug,
        title: input.title,
        excerpt: input.excerpt,
        body: input.body,
        status: input.status,
        publishedAt: input.status === 'published' ? now : null,
        authorMemberId: context.memberId ?? null,
      },
      include: { category: true },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'article.created',
      resourceType: 'kb_article',
      resourceId: article.id,
      ip: context.ip ?? null,
      metadata: { title: article.title, status: article.status },
    });

    return article;
  }

  async updateArticle(
    context: TenantContext,
    id: string,
    input: UpdateArticleInput,
  ): Promise<ArticleWithCategory> {
    requirePermission(context, Permission.KB_MANAGE);
    const existing = await this.getArticle(context, id);

    if (input.slug) await this.assertArticleSlugFree(existing.propertyId, input.slug, id);
    if (input.categoryId) {
      await this.assertCategoryBelongs(context, existing.propertyId, input.categoryId);
    }

    const now = this.clock.now();
    const data: Record<string, unknown> = { ...input };
    /**
     * `publishedAt` is when it *first* went public, and it stays that way.
     *
     * Re-publishing after an edit must not move the date: a reader looking at "published in March"
     * on an article that was corrected in August is being told something true, and rewriting it to
     * August would be a small lie that accumulates across a help centre.
     */
    if (input.status === 'published' && existing.status !== 'published') {
      data['publishedAt'] = existing.publishedAt ?? now;
    }

    return this.options.db.kbArticle.update({
      where: { id },
      data,
      include: { category: true },
    });
  }

  async deleteArticle(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.KB_MANAGE);
    await this.getArticle(context, id);
    await this.options.db.kbArticle.update({
      where: { id },
      data: { deletedAt: this.clock.now(), status: 'draft' },
    });
  }

  private async assertArticleSlugFree(
    propertyId: string,
    slug: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.options.db.kbArticle.findFirst({
      where: { propertyId, slug, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new AppError(ErrorCode.DUPLICATE_SLUG, 'That address is already in use');
  }

  /** A category id from another website - or another account - is a validation failure, not a write. */
  private async assertCategoryBelongs(
    context: TenantContext,
    propertyId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await this.options.db.kbCategory.findFirst({
      where: { accountId: context.accountId, propertyId, id: categoryId, deletedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'That section does not exist on this website',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // The public surface: no identity, published only
  // ---------------------------------------------------------------------------

  /**
   * Resolve a public id to a property, or refuse.
   *
   * The same lookup the widget uses, and for the same reason: a public id identifies a property
   * and authorises nothing, so everything downstream of it must be safe to serve to anybody.
   */
  private async resolvePublic(
    publicId: string,
  ): Promise<{ accountId: string; propertyId: string; name: string }> {
    const property = await this.widgets.findPublishedByPublicId(publicId);
    if (!property) throw new AppError(ErrorCode.PROPERTY_NOT_FOUND);
    await this.options.flags?.assertEnabled('public_help_centre', property.accountId);
    return {
      accountId: property.accountId,
      propertyId: property.propertyId,
      name: property.propertyName,
    };
  }

  async publicIndex(publicId: string): Promise<{
    property: { name: string };
    categories: { slug: string; name: string; description: string | null; articleCount: number }[];
    articles: Omit<PublicArticle, 'body'>[];
  }> {
    const property = await this.resolvePublic(publicId);

    const [categories, articles] = await Promise.all([
      this.options.db.kbCategory.findMany({
        where: { propertyId: property.propertyId, deletedAt: null },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        include: {
          _count: { select: { articles: { where: { status: 'published', deletedAt: null } } } },
        },
      }),
      this.options.db.kbArticle.findMany({
        where: { propertyId: property.propertyId, status: 'published', deletedAt: null },
        orderBy: [{ publishedAt: 'desc' }],
        take: 100,
        include: { category: true },
      }),
    ]);

    return {
      property: { name: property.name },
      categories: categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        description: category.description,
        articleCount: category._count.articles,
      })),
      articles: articles.map((article) => this.toPublicSummary(article)),
    };
  }

  async publicSearch(
    publicId: string,
    query: PublicKbSearchInput,
  ): Promise<Omit<PublicArticle, 'body'>[]> {
    const property = await this.resolvePublic(publicId);

    const articles = await this.options.db.kbArticle.findMany({
      where: {
        propertyId: property.propertyId,
        status: 'published',
        deletedAt: null,
        ...(query.category ? { category: { slug: query.category, deletedAt: null } } : {}),
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { excerpt: { contains: query.q, mode: 'insensitive' } },
                { body: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ publishedAt: 'desc' }],
      take: query.limit,
      include: { category: true },
    });

    /**
     * A title match is what somebody meant; a body match is what they might have meant.
     *
     * The ranking is applied to the page the database returned rather than inside the query,
     * so it reorders the results a reader is shown without claiming to reorder the whole
     * corpus. With `limit` capped at 50 that distinction only matters for a help centre with
     * more than fifty matches for one word, where the newest fifty is still a defensible set.
     */
    const needle = query.q?.toLowerCase();
    const ranked = needle
      ? [...articles].sort(
          (a, b) =>
            Number(b.title.toLowerCase().includes(needle)) -
            Number(a.title.toLowerCase().includes(needle)),
        )
      : articles;

    return ranked.map((article) => this.toPublicSummary(article));
  }

  /**
   * One published article, by its address.
   *
   * The view is counted here and only here. An author previewing their own draft goes through the
   * authenticated route and is not a reader, so the number means what it says.
   */
  async publicArticle(publicId: string, slug: string): Promise<PublicArticle> {
    const property = await this.resolvePublic(publicId);

    const article = await this.options.db.kbArticle.findFirst({
      where: {
        propertyId: property.propertyId,
        slug,
        status: 'published',
        deletedAt: null,
      },
      include: { category: true },
    });
    // A draft and a non-existent article answer identically, so the address of an unpublished
    // article cannot be probed for existence.
    if (!article) throw new AppError(ErrorCode.ARTICLE_NOT_FOUND);

    await this.options.db.kbArticle
      .update({ where: { id: article.id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    return { ...this.toPublicSummary(article), body: article.body };
  }

  private toPublicSummary(
    article: KbArticle & { category: KbCategory | null },
  ): Omit<PublicArticle, 'body'> {
    return {
      slug: article.slug,
      title: article.title,
      excerpt: article.excerpt,
      category: article.category
        ? { slug: article.category.slug, name: article.category.name }
        : null,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      updatedAt: article.updatedAt.toISOString(),
    };
  }
}
