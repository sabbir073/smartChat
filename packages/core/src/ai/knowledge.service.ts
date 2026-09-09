import type { Database, KnowledgeDocument } from '@smartchat/database';
import { newId } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { systemClock, type Clock } from '../time.js';
import { chunkDocument, contentHash, estimateTokens, plainText } from './chunker.js';
import type { AiGateway } from './gateway.js';

/**
 * The knowledge index: what the AI is allowed to answer from.
 *
 * Two kinds of document for now - published help-centre articles, and the notes the owner types
 * into the AI settings. Each is chunked, embedded and stored in `knowledge_chunks`, and retrieval
 * searches those chunks two ways at once (vector similarity and full text) for one property only.
 *
 * The embedding column is raw SQL from here down. Prisma cannot type `vector`, and the queries
 * are few enough that spelling them out is clearer than an abstraction. Every one of them begins
 * with `account_id = … AND property_id = …`: isolation is the query, not the model.
 */

export interface KnowledgeServiceOptions {
  db: Database;
  gateway: AiGateway;
  /** The dashboard's origin, for the help-centre URLs that "answered from" points at. */
  appUrl: string;
  clock?: Clock;
  embedTimeoutMs?: number;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  kind: 'article' | 'notes' | 'page';
  title: string;
  url: string | null;
  heading: string | null;
  text: string;
  score: number;
}

export interface KnowledgeStatus {
  documents: number;
  /** How many of the documents are crawled pages. */
  pages: number;
  chunks: number;
  lastIndexedAt: Date | null;
  /** Documents whose last indexing failed, with the reason. */
  failures: Array<{ documentId: string; title: string; error: string }>;
  /** Documents that have been written but not yet indexed. */
  pending: number;
}

export const MAX_NOTES_CHARS = 20_000;

export class KnowledgeService {
  private readonly clock: Clock;
  private readonly embedTimeoutMs: number;

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.embedTimeoutMs = options.embedTimeoutMs ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  /**
   * Mirror one article into the index. Published and not deleted: a document exists for it and
   * is returned when its content changed (so the caller can queue the indexing). Anything else:
   * its document, if any, is removed along with its chunks.
   */
  async syncArticle(article: {
    id: string;
    accountId: string;
    propertyId: string;
    title: string;
    slug: string;
    body: string;
    status: 'draft' | 'published';
    deletedAt: Date | null;
    propertyPublicId: string;
  }): Promise<{ documentId: string; changed: boolean } | null> {
    const existing = await this.options.db.knowledgeDocument.findUnique({
      where: { accountId_articleId: { accountId: article.accountId, articleId: article.id } },
    });

    if (article.status !== 'published' || article.deletedAt) {
      if (existing) await this.deleteDocument(article.accountId, existing.id);
      return null;
    }

    const text = plainText(article.body);
    const hash = contentHash(article.title, text);
    const url = `${this.options.appUrl.replace(/\/+$/, '')}/help/${article.propertyPublicId}/${article.slug}`;

    if (existing) {
      if (existing.contentHash === hash && existing.url === url && existing.indexedAt && !existing.error) {
        return { documentId: existing.id, changed: false };
      }
      await this.options.db.knowledgeDocument.update({
        where: { id: existing.id },
        data: { title: article.title, url, text, contentHash: hash, tokenCount: estimateTokens(text), error: null },
      });
      return { documentId: existing.id, changed: true };
    }

    const created = await this.options.db.knowledgeDocument.create({
      data: {
        accountId: article.accountId,
        propertyId: article.propertyId,
        kind: 'article',
        articleId: article.id,
        title: article.title,
        url,
        text,
        contentHash: hash,
        tokenCount: estimateTokens(text),
      },
    });
    return { documentId: created.id, changed: true };
  }

  /** The owner's key facts. Empty text removes the document. */
  async syncNotes(
    accountId: string,
    propertyId: string,
    keyFacts: string,
  ): Promise<{ documentId: string; changed: boolean } | null> {
    const text = keyFacts.trim().slice(0, MAX_NOTES_CHARS);
    const existing = await this.options.db.knowledgeDocument.findFirst({
      where: { accountId, propertyId, kind: 'notes' },
    });
    if (text.length === 0) {
      if (existing) await this.deleteDocument(accountId, existing.id);
      return null;
    }
    const title = 'Key facts';
    const hash = contentHash(title, text);
    if (existing) {
      if (existing.contentHash === hash && existing.indexedAt && !existing.error) {
        return { documentId: existing.id, changed: false };
      }
      await this.options.db.knowledgeDocument.update({
        where: { id: existing.id },
        data: { text, contentHash: hash, tokenCount: estimateTokens(text), error: null },
      });
      return { documentId: existing.id, changed: true };
    }
    const created = await this.options.db.knowledgeDocument.create({
      data: {
        accountId,
        propertyId,
        kind: 'notes',
        title,
        text,
        contentHash: hash,
        tokenCount: estimateTokens(text),
      },
    });
    return { documentId: created.id, changed: true };
  }

  /**
   * One crawled page. Upserted by URL; unchanged content is only stamped as seen, so a weekly
   * re-crawl of a site that has not changed embeds nothing.
   */
  async syncPage(
    accountId: string,
    propertyId: string,
    page: { url: string; title: string; text: string; description: string | null },
    seenAt: Date,
  ): Promise<{ documentId: string; changed: boolean }> {
    const text = (page.description ? `${page.description}\n\n${page.text}` : page.text).slice(0, 200_000);
    const hash = contentHash(page.title, text);
    const existing = await this.options.db.knowledgeDocument.findUnique({
      where: { accountId_propertyId_url: { accountId, propertyId, url: page.url } },
    });
    if (existing) {
      if (existing.kind === 'page' && existing.contentHash === hash && existing.indexedAt && !existing.error) {
        await this.options.db.knowledgeDocument.update({ where: { id: existing.id }, data: { lastSeenAt: seenAt } });
        return { documentId: existing.id, changed: false };
      }
      await this.options.db.knowledgeDocument.update({
        where: { id: existing.id },
        data: { kind: 'page', title: page.title, text, contentHash: hash, tokenCount: estimateTokens(text), error: null, lastSeenAt: seenAt },
      });
      return { documentId: existing.id, changed: true };
    }
    const created = await this.options.db.knowledgeDocument.create({
      data: {
        accountId,
        propertyId,
        kind: 'page',
        title: page.title,
        url: page.url,
        text,
        contentHash: hash,
        tokenCount: estimateTokens(text),
        lastSeenAt: seenAt,
      },
    });
    return { documentId: created.id, changed: true };
  }

  /** Pages a completed crawl did not find any more are gone from the site; they go from the index. */
  async prunePages(accountId: string, propertyId: string, seenBefore: Date): Promise<number> {
    const result = await this.options.db.knowledgeDocument.deleteMany({
      where: { accountId, propertyId, kind: 'page', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: seenBefore } }] },
    });
    return result.count;
  }

  async deleteDocument(accountId: string, documentId: string): Promise<void> {
    // Chunks go with the document (ON DELETE CASCADE).
    await this.options.db.knowledgeDocument.deleteMany({ where: { accountId, id: documentId } });
  }

  /**
   * Chunk, embed, replace. The old chunks stay in place until the new ones are ready, so a
   * failure mid-way leaves the previous index answering rather than nothing. The replacement is
   * one transaction.
   */
  async indexDocument(accountId: string, documentId: string): Promise<{ chunks: number }> {
    const document = await this.options.db.knowledgeDocument.findFirst({
      where: { accountId, id: documentId },
    });
    if (!document) return { chunks: 0 };

    try {
      const chunks = chunkDocument(document.text);
      const embeddings = this.options.gateway.embeddings;
      const vectors: number[][] = [];
      // Batches of 16 keep one request under the timeout on a CPU and keep memory flat.
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const result = await embeddings.embedDocuments(
          batch.map((chunk) => ({
            title: chunk.heading ? `${document.title} › ${chunk.heading}` : document.title,
            text: chunk.text,
          })),
          this.embedTimeoutMs,
        );
        vectors.push(...result.vectors);
      }

      const now = this.clock.now();
      await this.options.db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM knowledge_chunks WHERE account_id = ${accountId}::uuid AND document_id = ${documentId}::uuid`;
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
          const vector = vectors[i]!;
          await tx.$executeRaw`
            INSERT INTO knowledge_chunks
              (id, account_id, property_id, document_id, ordinal, heading, text, token_count, embedding, created_at)
            VALUES
              (${newId()}::uuid, ${accountId}::uuid, ${document.propertyId}::uuid, ${documentId}::uuid,
               ${chunk.ordinal}, ${chunk.heading}, ${chunk.text}, ${chunk.tokenCount},
               ${toVectorLiteral(vector)}::vector, ${now})`;
        }
        await tx.knowledgeDocument.update({
          where: { id: documentId },
          data: { chunkCount: chunks.length, indexedAt: now, error: null },
        });
      });
      return { chunks: chunks.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.db.knowledgeDocument.updateMany({
        where: { accountId, id: documentId },
        data: { error: message.slice(0, 500) },
      });
      throw error;
    }
  }

  /** Every document of a property, in turn. Used by "re-index" and after the embedding model changes. */
  async listDocumentIds(
    accountId: string,
    propertyId: string,
    kinds?: Array<'article' | 'notes' | 'page'>,
  ): Promise<string[]> {
    const rows = await this.options.db.knowledgeDocument.findMany({
      where: { accountId, propertyId, ...(kinds ? { kind: { in: kinds } } : {}) },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  async status(accountId: string, propertyId: string): Promise<KnowledgeStatus> {
    const documents = await this.options.db.knowledgeDocument.findMany({
      where: { accountId, propertyId },
      select: { id: true, title: true, kind: true, chunkCount: true, indexedAt: true, error: true },
    });
    let chunks = 0;
    let pages = 0;
    let lastIndexedAt: Date | null = null;
    let pending = 0;
    const failures: KnowledgeStatus['failures'] = [];
    for (const document of documents) {
      chunks += document.chunkCount;
      if (document.kind === 'page') pages += 1;
      if (document.indexedAt && (!lastIndexedAt || document.indexedAt > lastIndexedAt)) {
        lastIndexedAt = document.indexedAt;
      }
      if (document.error) failures.push({ documentId: document.id, title: document.title, error: document.error });
      else if (!document.indexedAt) pending += 1;
    }
    return { documents: documents.length, pages, chunks, lastIndexedAt, failures: failures.slice(0, 20), pending };
  }

  async document(accountId: string, documentId: string): Promise<KnowledgeDocument | null> {
    return this.options.db.knowledgeDocument.findFirst({ where: { accountId, id: documentId } });
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  /**
   * The passages for a question: the union of the vector and full-text top lists, fused by
   * reciprocal rank, plus the owner's key facts if they are relevant at all. If the embedding
   * model is unreachable the full-text half still answers - a degraded search is better than a
   * ticket offer for a question the article plainly covers.
   */
  async retrieve(
    accountId: string,
    propertyId: string,
    question: string,
    limit = 8,
  ): Promise<{ chunks: RetrievedChunk[]; embedded: boolean }> {
    const trimmed = question.trim().slice(0, 2_000);
    if (!trimmed) return { chunks: [], embedded: false };

    let vector: number[] | null = null;
    try {
      vector = await this.options.gateway.embeddings.embedQuery(trimmed, 15_000);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.AI_UNAVAILABLE) throw error;
      vector = null;
    }

    const candidates = 20;
    const rows = vector
      ? await this.options.db.$queryRaw<RetrievedRow[]>`
          WITH vec AS (
            SELECT id, row_number() OVER (ORDER BY embedding <=> ${toVectorLiteral(vector)}::vector) AS rank
            FROM knowledge_chunks
            WHERE account_id = ${accountId}::uuid AND property_id = ${propertyId}::uuid
            ORDER BY embedding <=> ${toVectorLiteral(vector)}::vector
            LIMIT ${candidates}
          ),
          txt AS (
            SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.search, q) DESC) AS rank
            FROM knowledge_chunks c, websearch_to_tsquery('simple', ${trimmed}) q
            WHERE c.account_id = ${accountId}::uuid AND c.property_id = ${propertyId}::uuid AND c.search @@ q
            ORDER BY ts_rank_cd(c.search, q) DESC
            LIMIT ${candidates}
          ),
          fused AS (
            SELECT id, SUM(1.0 / (60 + rank)) AS score
            FROM (SELECT id, rank FROM vec UNION ALL SELECT id, rank FROM txt) u
            GROUP BY id
          )
          SELECT c.id AS chunk_id, c.document_id, d.kind::text AS kind, d.title, d.url, c.heading, c.text,
                 (f.score + CASE WHEN d.kind = 'notes' THEN 0.004 ELSE 0 END)::float8 AS score
          FROM fused f
          JOIN knowledge_chunks c ON c.id = f.id
          JOIN knowledge_documents d ON d.id = c.document_id
          ORDER BY score DESC
          LIMIT ${limit}`
      : await this.options.db.$queryRaw<RetrievedRow[]>`
          SELECT c.id AS chunk_id, c.document_id, d.kind::text AS kind, d.title, d.url, c.heading, c.text,
                 ts_rank_cd(c.search, q)::float8 AS score
          FROM knowledge_chunks c
          JOIN knowledge_documents d ON d.id = c.document_id,
               websearch_to_tsquery('simple', ${trimmed}) q
          WHERE c.account_id = ${accountId}::uuid AND c.property_id = ${propertyId}::uuid AND c.search @@ q
          ORDER BY score DESC
          LIMIT ${limit}`;

    return {
      chunks: rows.map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        kind: row.kind === 'notes' ? 'notes' : row.kind === 'page' ? 'page' : 'article',
        title: row.title,
        url: row.url,
        heading: row.heading,
        text: row.text,
        score: Number(row.score),
      })),
      embedded: vector !== null,
    };
  }
}

interface RetrievedRow {
  chunk_id: string;
  document_id: string;
  kind: string;
  title: string;
  url: string | null;
  heading: string | null;
  text: string;
  score: number;
}

/** pgvector's text form: `[0.1,0.2,…]`. Numbers are written with limited precision to keep the statement small. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => (Number.isFinite(n) ? n.toFixed(7) : '0')).join(',')}]`;
}
