'use client';

import { useState } from 'react';
import { Button, Field, Modal, Select, TextInput, cn } from '@/components/ui';
import { renderMarkdown } from '@/lib/markdown';
import type { KbArticleDto, KbCategoryDto } from '@/lib/types';

export interface ArticleDraft {
  id?: string;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  categoryId: string;
  status: 'draft' | 'published';
  /**
   * Whether the address is still following the title.
   *
   * It follows until the author touches it, and never at all once the article has been saved -
   * by then somebody may have shared the link, and quietly moving it would break theirs.
   */
  slugLocked: boolean;
}

/** The same suggestion the server would make, so the field shows what saving would produce. */
export function suggestSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : '';
}

export function emptyArticle(categoryId = ''): ArticleDraft {
  return {
    title: '',
    slug: '',
    excerpt: '',
    body: '',
    categoryId,
    status: 'draft',
    slugLocked: false,
  };
}

export function articleDraftFrom(article: KbArticleDto): ArticleDraft {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt ?? '',
    body: article.body,
    categoryId: article.category?.id ?? '',
    status: article.status,
    slugLocked: true,
  };
}

export function ArticleEditor({
  open,
  draft,
  categories,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  draft: ArticleDraft;
  categories: KbCategoryDto[];
  saving: boolean;
  error: string | null;
  onChange: (draft: ArticleDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const set = (patch: Partial<ArticleDraft>) => onChange({ ...draft, ...patch });

  const setTitle = (title: string) =>
    set(draft.slugLocked ? { title } : { title, slug: suggestSlug(title) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={draft.id ? 'Edit article' : 'New article'}
      description="Written in markdown. Readers see it at the address below."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.status === 'published'}
              onChange={(event) => set({ status: event.target.checked ? 'published' : 'draft' })}
            />
            Published - visible in the help centre
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} loading={saving}>
              {draft.id ? 'Save changes' : 'Create article'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {error && (
          <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <Field label="Title" required>
          {({ id }) => (
            <TextInput
              id={id}
              value={draft.title}
              maxLength={160}
              placeholder="How refunds work"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Address"
          hint={
            draft.id
              ? 'Changing this breaks any link somebody has already shared.'
              : 'Suggested from the title until you edit it.'
          }
          required
        >
          {({ id }) => (
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 font-mono text-[13px] text-ink-subtle">/help/.../</span>
              <TextInput
                id={id}
                value={draft.slug}
                maxLength={80}
                placeholder="how-refunds-work"
                onChange={(event) => set({ slug: event.target.value, slugLocked: true })}
              />
            </div>
          )}
        </Field>

        <Field label="Section">
          {({ id }) => (
            <Select
              id={id}
              value={draft.categoryId}
              onChange={(event) => set({ categoryId: event.target.value })}
            >
              <option value="">No section</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Summary"
          hint="One or two lines shown in the article list and in search results. Optional."
        >
          {({ id }) => (
            <TextInput
              id={id}
              value={draft.excerpt}
              maxLength={300}
              placeholder="We refund card payments within 14 days."
              onChange={(event) => set({ excerpt: event.target.value })}
            />
          )}
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">
              Article
              <span className="ml-0.5 text-danger" aria-hidden="true">
                *
              </span>
            </span>
            <div className="flex gap-1" role="tablist" aria-label="Article body">
              {(['write', 'preview'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry}
                  onClick={() => setTab(entry)}
                  className={cn(
                    'rounded-full px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                    tab === entry
                      ? 'bg-ink text-ink-inverted'
                      : 'text-ink-muted hover:bg-surface-raised',
                  )}
                >
                  {entry}
                </button>
              ))}
            </div>
          </div>

          {tab === 'write' ? (
            <textarea
              rows={14}
              maxLength={100000}
              value={draft.body}
              placeholder={'## Getting a refund\n\n1. Open your receipt\n2. Choose **Refund**'}
              onChange={(event) => set({ body: event.target.value })}
              className="w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed text-ink placeholder:text-ink-subtle"
            />
          ) : (
            <div
              className="kb-prose min-h-[14rem] rounded-[var(--radius-control)] border border-border-strong bg-surface px-4 py-3"
              // The same renderer the public page uses, on text that was escaped before any tag
              // existed. What is previewed here is exactly what a reader will be sent.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.body) }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
