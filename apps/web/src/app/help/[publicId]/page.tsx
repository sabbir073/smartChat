import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PublicApiError, publicApiGet } from '@/lib/public-api';
import type { PublicArticleSummary, PublicKbIndexDto } from '@/lib/types';

/**
 * The public help centre.
 *
 * Rendered on the server with no session, no cookies and no account context. The only thing in
 * the address is a property's public id, which authorises nothing - exactly like the widget's.
 */

interface PageProps {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ q?: string; category?: string }>;
}

/** The same shape the API accepts, checked here so a nonsense address 404s before any request. */
const PUBLIC_ID = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/;

async function loadIndex(publicId: string): Promise<PublicKbIndexDto> {
  try {
    return await publicApiGet<PublicKbIndexDto>(`/public/kb/${publicId}`);
  } catch (error) {
    if (error instanceof PublicApiError && error.isNotFound) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId } = await params;
  if (!PUBLIC_ID.test(publicId)) return { title: 'Help centre' };
  try {
    const index = await publicApiGet<PublicKbIndexDto>(`/public/kb/${publicId}`);
    return {
      title: `${index.property.name} help centre`,
      description: `Answers and guides for ${index.property.name}.`,
    };
  } catch {
    // A title is not worth failing a page render over.
    return { title: 'Help centre' };
  }
}

function ArticleCard({ publicId, article }: { publicId: string; article: PublicArticleSummary }) {
  return (
    <li>
      <Link
        href={`/help/${publicId}/${article.slug}`}
        className="block rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 transition-colors hover:border-border-strong"
      >
        <h3 className="text-[15px] font-semibold text-ink">{article.title}</h3>
        {article.excerpt && (
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{article.excerpt}</p>
        )}
        {article.category && (
          <p className="mt-2 text-[12px] font-medium uppercase tracking-wide text-ink-subtle">
            {article.category.name}
          </p>
        )}
      </Link>
    </li>
  );
}

export default async function HelpCentrePage({ params, searchParams }: PageProps) {
  const { publicId } = await params;
  if (!PUBLIC_ID.test(publicId)) notFound();

  const { q, category } = await searchParams;
  const index = await loadIndex(publicId);

  const query = (q ?? '').trim();
  const searching = query.length >= 2 || Boolean(category);

  const results = searching
    ? await publicApiGet<PublicArticleSummary[]>(`/public/kb/${publicId}/search`, {
        ...(query.length >= 2 ? { q: query } : {}),
        ...(category ? { category } : {}),
      }).catch((error: unknown) => {
        if (error instanceof PublicApiError && error.isNotFound) notFound();
        throw error;
      })
    : null;

  const shown = results ?? index.articles;
  const activeCategory = index.categories.find((entry) => entry.slug === category) ?? null;

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header className="mb-8">
        <p className="text-[13px] font-medium uppercase tracking-wide text-ink-subtle">
          Help centre
        </p>
        <h1 className="mt-1 text-[28px] font-semibold leading-tight text-ink">
          {index.property.name}
        </h1>
      </header>

      {/*
        A plain form with a GET action: the results are a URL somebody can share or bookmark, and
        the search works with JavaScript switched off. There is nothing here that needs a client
        component.
      */}
      <form action={`/help/${publicId}`} className="mb-8 flex gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          minLength={2}
          maxLength={120}
          placeholder="Search for an answer"
          aria-label="Search the help centre"
          className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-4 text-sm text-ink placeholder:text-ink-subtle"
        />
        {category && <input type="hidden" name="category" value={category} />}
        <button
          type="submit"
          className="h-11 shrink-0 rounded-[var(--radius-control)] bg-brand px-5 text-sm font-medium text-ink-inverted hover:bg-brand-hover"
        >
          Search
        </button>
      </form>

      {index.categories.length > 0 && (
        <nav className="mb-8 flex flex-wrap gap-2" aria-label="Sections">
          <Link
            href={`/help/${publicId}${query ? `?q=${encodeURIComponent(query)}` : ''}`}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
              category
                ? 'border-border bg-surface text-ink-muted'
                : 'border-ink bg-ink text-ink-inverted'
            }`}
          >
            All
          </Link>
          {index.categories.map((entry) => (
            <Link
              key={entry.slug}
              href={`/help/${publicId}?category=${encodeURIComponent(entry.slug)}${
                query ? `&q=${encodeURIComponent(query)}` : ''
              }`}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
                category === entry.slug
                  ? 'border-ink bg-ink text-ink-inverted'
                  : 'border-border bg-surface text-ink-muted'
              }`}
            >
              {entry.name}
              <span className="ml-1.5 text-ink-subtle">{entry.articleCount}</span>
            </Link>
          ))}
        </nav>
      )}

      {activeCategory?.description && (
        <p className="mb-6 text-sm text-ink-muted">{activeCategory.description}</p>
      )}

      {shown.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface px-6 py-12 text-center">
          <h2 className="text-[15px] font-semibold text-ink">
            {searching ? 'Nothing matched that' : 'Nothing published yet'}
          </h2>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted">
            {searching
              ? 'Try fewer words, or start a chat and somebody will help you directly.'
              : 'This help centre has no articles yet. Start a chat and somebody will help you directly.'}
          </p>
        </div>
      ) : (
        <>
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wide text-ink-subtle">
            {searching ? `${shown.length} result${shown.length === 1 ? '' : 's'}` : 'All articles'}
          </h2>
          <ul className="space-y-2.5">
            {shown.map((article) => (
              <ArticleCard key={article.slug} publicId={publicId} article={article} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
