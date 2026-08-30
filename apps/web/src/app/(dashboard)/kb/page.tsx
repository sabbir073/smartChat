'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import {
  ArticleEditor,
  articleDraftFrom,
  emptyArticle,
  type ArticleDraft,
} from '@/components/kb/article-editor';
import { CategoryManager, type CategoryDraft } from '@/components/kb/category-manager';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Select,
  Spinner,
  TextInput,
  cn,
  useToast,
} from '@/components/ui';
import type { KbArticleDto, KbCategoryDto, PropertyDto } from '@/lib/types';

/**
 * The help centre, from the writing side.
 *
 * A knowledge base belongs to one website rather than to the account, so a website has to be
 * chosen before anything can be listed. A restricted agent only sees the websites they work on,
 * which is why the picker is populated from the API rather than from anything held locally.
 */
export default function KnowledgeBasePage() {
  const { activeAccount, can } = useAuth();
  const toast = useToast();

  const canView = can('kb:view');
  const canManage = can('kb:manage');

  const [tab, setTab] = useState<'articles' | 'sections'>('articles');
  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [propertyId, setPropertyId] = useState<string>('');
  const [categories, setCategories] = useState<KbCategoryDto[]>([]);
  const [articles, setArticles] = useState<KbArticleDto[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'draft' | 'published'>('');

  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ArticleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  const property = properties.find((entry) => entry.id === propertyId) ?? null;

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!canView) {
      setLoadingProperties(false);
      return undefined;
    }
    let active = true;
    api
      .get<PropertyDto[]>('/properties')
      .then((result) => {
        if (!active) return;
        setProperties(result.data);
        setPropertyId((current) => current || (result.data[0]?.id ?? ''));
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof ApiError ? caught.message : 'Websites could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setLoadingProperties(false);
      });
    return () => {
      active = false;
    };
  }, [canView, activeAccount?.id]);

  const load = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);
    try {
      const [categoryResult, articleResult] = await Promise.all([
        api.get<KbCategoryDto[]>(`/kb/${propertyId}/categories`),
        api.get<KbArticleDto[]>(`/kb/${propertyId}/articles`, {
          query: {
            ...(search.trim().length > 0 ? { search: search.trim() } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        }),
      ]);
      setCategories(categoryResult.data);
      setArticles(articleResult.data);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The knowledge base could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, search, statusFilter]);

  useEffect(() => {
    if (!canView || !propertyId) return undefined;
    // A short delay so typing in the search box does not fire a request per keystroke.
    const timer = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, canView, propertyId, search]);

  const publishedPerCategory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const article of articles) {
      if (article.status !== 'published' || !article.category) continue;
      counts[article.category.id] = (counts[article.category.id] ?? 0) + 1;
    }
    return counts;
  }, [articles]);

  const helpCentreUrl = property && origin ? `${origin}/help/${property.publicId}` : null;

  async function saveArticle(): Promise<void> {
    if (!draft || !propertyId) return;
    setSaving(true);
    setFormError(null);
    const body = {
      title: draft.title,
      slug: draft.slug === '' ? undefined : draft.slug,
      excerpt: draft.excerpt.trim() === '' ? null : draft.excerpt.trim(),
      body: draft.body,
      categoryId: draft.categoryId === '' ? null : draft.categoryId,
      status: draft.status,
    };
    try {
      if (draft.id) {
        const result = await api.patch<KbArticleDto>(`/kb/articles/${draft.id}`, body);
        setArticles((current) =>
          current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
        );
      } else {
        const result = await api.post<KbArticleDto>(`/kb/${propertyId}/articles`, body);
        setArticles((current) => [result.data, ...current]);
      }
      setDraft(null);
      toast.success('Article saved');
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function togglePublished(article: KbArticleDto): Promise<void> {
    try {
      const result = await api.patch<KbArticleDto>(`/kb/articles/${article.id}`, {
        status: article.status === 'published' ? 'draft' : 'published',
      });
      setArticles((current) =>
        current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be changed.');
    }
  }

  async function removeArticle(article: KbArticleDto): Promise<void> {
    try {
      await api.delete(`/kb/articles/${article.id}`);
      setArticles((current) => current.filter((entry) => entry.id !== article.id));
      toast.success(`"${article.title}" removed`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be removed.');
    }
  }

  async function createCategory(input: CategoryDraft): Promise<void> {
    const result = await api.post<KbCategoryDto>(`/kb/${propertyId}/categories`, {
      name: input.name,
      slug: input.slug === '' ? undefined : input.slug,
      description: input.description.trim() === '' ? null : input.description.trim(),
      position: input.position,
    });
    setCategories((current) => [...current, result.data]);
  }

  async function updateCategory(id: string, input: CategoryDraft): Promise<void> {
    const result = await api.patch<KbCategoryDto>(`/kb/categories/${id}`, {
      name: input.name,
      slug: input.slug,
      description: input.description.trim() === '' ? null : input.description.trim(),
      position: input.position,
    });
    setCategories((current) =>
      current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
    );
  }

  async function deleteCategory(category: KbCategoryDto): Promise<void> {
    try {
      await api.delete(`/kb/categories/${category.id}`);
      setCategories((current) => current.filter((entry) => entry.id !== category.id));
      // The articles kept their content but lost their section, so the list is now stale.
      await load();
      toast.success(`"${category.name}" removed`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be removed.');
    }
  }

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Help centre" />
        <EmptyState
          title="You do not have access to the knowledge base"
          description="Ask an owner or administrator of this account if you need it."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Help centre"
        description="Articles your visitors can read without waiting for an agent."
        action={
          canManage && propertyId && tab === 'articles' ? (
            <Button
              onClick={() => {
                setFormError(null);
                setDraft(emptyArticle());
              }}
            >
              New article
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {loadingProperties ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : properties.length === 0 ? (
        <EmptyState
          title="No websites yet"
          description="A help centre belongs to a website. Add one first, then write your first article."
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-4">
            {/*
              The controls carry `w-full` of their own, so a width goes on a wrapper rather than
              on the control - two width utilities on one element is a coin toss decided by
              stylesheet order.
            */}
            <label className="flex w-64 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-muted">Website</span>
              <Select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
                {properties.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </label>

            {helpCentreUrl && (
              <a
                href={helpCentreUrl}
                target="_blank"
                rel="noreferrer"
                className="pb-2.5 text-[13px] font-medium text-brand hover:underline"
              >
                Open the public help centre
              </a>
            )}
          </div>

          <div className="mb-5 flex gap-1" role="tablist" aria-label="Help centre">
            {(['articles', 'sections'] as const).map((entry) => (
              <button
                key={entry}
                role="tab"
                aria-selected={tab === entry}
                onClick={() => setTab(entry)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors',
                  tab === entry
                    ? 'bg-ink text-ink-inverted'
                    : 'text-ink-muted hover:bg-surface-raised',
                )}
              >
                {entry}
              </button>
            ))}
          </div>

          {tab === 'sections' ? (
            <CategoryManager
              categories={categories}
              counts={publishedPerCategory}
              canManage={canManage}
              onCreate={createCategory}
              onUpdate={updateCategory}
              onDelete={deleteCategory}
            />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-3">
                <div className="w-80">
                  <TextInput
                    value={search}
                    placeholder="Search titles and text"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="w-44">
                  <Select
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as '' | 'draft' | 'published')
                    }
                  >
                    <option value="">Any status</option>
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                  </Select>
                </div>
              </div>

              {loading ? (
                <div className="flex justify-center py-16">
                  <Spinner />
                </div>
              ) : articles.length === 0 ? (
                <EmptyState
                  title={search ? 'Nothing matched' : 'No articles yet'}
                  description={
                    search
                      ? 'Try a shorter search, or clear it to see everything.'
                      : 'An article answers a question once, so your team does not have to answer it every day.'
                  }
                />
              ) : (
                <div className="space-y-2">
                  {articles.map((article) => (
                    <Card key={article.id}>
                      <CardBody className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="truncate text-[15px] font-semibold text-ink">
                              {article.title}
                            </h2>
                            <Badge tone={article.status === 'published' ? 'success' : 'neutral'}>
                              {article.status}
                            </Badge>
                            {article.category && <Badge tone="brand">{article.category.name}</Badge>}
                          </div>
                          <p className="mt-1 text-[13px] text-ink-subtle">
                            <span className="font-mono">/{article.slug}</span>
                            {' · '}
                            {article.viewCount} view{article.viewCount === 1 ? '' : 's'}
                            {article.publishedAt
                              ? ` · published ${new Date(article.publishedAt).toLocaleDateString()}`
                              : ''}
                          </p>
                          {article.excerpt && (
                            <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
                              {article.excerpt}
                            </p>
                          )}
                        </div>

                        {canManage && (
                          <div className="flex shrink-0 gap-2">
                            <Button variant="secondary" onClick={() => void togglePublished(article)}>
                              {article.status === 'published' ? 'Unpublish' : 'Publish'}
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setFormError(null);
                                setDraft(articleDraftFrom(article));
                              }}
                            >
                              Edit
                            </Button>
                            <Button variant="ghost" onClick={() => void removeArticle(article)}>
                              Remove
                            </Button>
                          </div>
                        )}
                      </CardBody>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {draft && (
        <ArticleEditor
          open
          draft={draft}
          categories={categories}
          saving={saving}
          error={formError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void saveArticle()}
        />
      )}
    </div>
  );
}
