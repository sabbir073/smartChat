import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { renderMarkdown } from '@/lib/markdown';
import { PublicApiError, publicApiGet } from '@/lib/public-api';
import type { PublicArticleDto } from '@/lib/types';

interface PageProps {
  params: Promise<{ publicId: string; slug: string }>;
}

const PUBLIC_ID = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One published article.
 *
 * A draft and an article that never existed produce the same 404, so an unpublished address
 * cannot be probed for existence by a stranger who guesses well.
 */
async function loadArticle(publicId: string, slug: string): Promise<PublicArticleDto> {
  try {
    return await publicApiGet<PublicArticleDto>(`/public/kb/${publicId}/articles/${slug}`);
  } catch (error) {
    if (error instanceof PublicApiError && error.isNotFound) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId, slug } = await params;
  if (!PUBLIC_ID.test(publicId) || !SLUG.test(slug)) return { title: 'Help centre' };
  try {
    const article = await publicApiGet<PublicArticleDto>(
      `/public/kb/${publicId}/articles/${slug}`,
    );
    return {
      title: article.title,
      ...(article.excerpt ? { description: article.excerpt } : {}),
    };
  } catch {
    return { title: 'Help centre' };
  }
}

export default async function HelpArticlePage({ params }: PageProps) {
  const { publicId, slug } = await params;
  if (!PUBLIC_ID.test(publicId) || !SLUG.test(slug)) notFound();

  const article = await loadArticle(publicId, slug);
  const published = article.publishedAt ? new Date(article.publishedAt) : null;
  const updated = new Date(article.updatedAt);

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <Link
        href={
          article.category
            ? `/help/${publicId}?category=${encodeURIComponent(article.category.slug)}`
            : `/help/${publicId}`
        }
        className="text-[13px] font-medium text-brand hover:underline"
      >
        ← {article.category ? article.category.name : 'All articles'}
      </Link>

      <article className="mt-5 rounded-[var(--radius-card)] border border-border bg-surface px-7 py-8">
        <h1 className="text-[28px] font-semibold leading-tight text-ink">{article.title}</h1>

        <p className="mt-2 text-[13px] text-ink-subtle">
          {published && (
            <>
              Published <time dateTime={article.publishedAt ?? ''}>{published.toLocaleDateString()}</time>
            </>
          )}
          {published && updated.getTime() - published.getTime() > 60_000 && ' · '}
          {updated.getTime() - (published?.getTime() ?? 0) > 60_000 && (
            <>
              Updated <time dateTime={article.updatedAt}>{updated.toLocaleDateString()}</time>
            </>
          )}
        </p>

        {article.excerpt && (
          <p className="mt-4 border-l-2 border-brand-ring pl-4 text-[15px] leading-relaxed text-ink-muted">
            {article.excerpt}
          </p>
        )}

        {/*
          The body is markdown written by an agent of this account. It is HTML-escaped before any
          tag is inserted around it - see `renderMarkdown` - so nothing an author types can become
          markup, and a compromised agent account cannot turn a help article into a script that
          runs in a stranger's browser.
        */}
        <div
          className="kb-prose mt-6"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(article.body) }}
        />
      </article>

      <p className="mt-6 text-center text-[13px] text-ink-subtle">
        Still stuck?{' '}
        <Link href={`/help/${publicId}`} className="font-medium text-brand hover:underline">
          Browse the rest of the help centre
        </Link>
        .
      </p>
    </main>
  );
}
