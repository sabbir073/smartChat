import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@smartchat/database';
import { ActorType, Permission, type TenantContext } from '@smartchat/types';
import type { QueueProducer } from '../queue/producer.js';
import type { KnowledgeService } from './knowledge.service.js';
import { KnowledgeSourceService, MAX_LINKS_PER_PROPERTY } from './sources.service.js';

/**
 * Pages an owner pastes in, and the buttons that make the assistant forget a source.
 *
 * What is worth pinning here is not the happy path - it is the edges where the wrong behaviour
 * would be quietly damaging: an address that is not reachable from the internet being queued, a
 * page that fails to read losing the reason, and "forget the feed" leaving the feed address
 * behind so the next sync brings every product straight back.
 */

interface Doc {
  id: string;
  accountId: string;
  propertyId: string;
  kind: string;
  url: string | null;
  title: string;
  error: string | null;
  chunkCount: number;
  indexedAt: Date | null;
  createdAt: Date;
}

function fixture(overrides: { documents?: Doc[]; settings?: Record<string, unknown> } = {}) {
  const documents: Doc[] = overrides.documents ?? [];
  const settings: Record<string, unknown> = overrides.settings ?? {
    productFeedUrl: 'https://shop.example.com/feed.xml',
    feedProducts: 12,
    keyFacts: 'We open at ten.',
  };
  let nextId = documents.length + 1;

  const db = {
    property: {
      findFirst: vi.fn(async () => ({ id: 'prop-1' })),
    },
    knowledgeDocument: {
      findMany: vi.fn(async ({ where }: { where: { kind?: string } }) =>
        documents.filter((doc) => (where.kind ? doc.kind === where.kind : true)),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; kind?: string } }) =>
        documents.find((doc) => doc.id === where.id && (!where.kind || doc.kind === where.kind)) ?? null,
      ),
      count: vi.fn(async ({ where }: { where: { kind?: string; url?: { notIn: string[] } } }) =>
        documents.filter(
          (doc) =>
            (!where.kind || doc.kind === where.kind) &&
            (!where.url || !where.url.notIn.includes(doc.url ?? '')),
        ).length,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { accountId_propertyId_url: { url: string } }; create: Record<string, unknown> }) => {
        const url = where.accountId_propertyId_url.url;
        const existing = documents.find((doc) => doc.url === url);
        if (existing) {
          existing.kind = 'link';
          existing.error = null;
          existing.indexedAt = null;
          return { id: existing.id };
        }
        const created: Doc = {
          id: `doc-${nextId++}`,
          accountId: 'acc-1',
          propertyId: 'prop-1',
          kind: 'link',
          url,
          title: String(create['title']),
          error: null,
          chunkCount: 0,
          indexedAt: null,
          createdAt: new Date('2026-09-15T10:00:00Z'),
        };
        documents.push(created);
        return { id: created.id };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string }; data: Record<string, unknown> }) => {
        for (const doc of documents.filter((entry) => entry.id === where.id)) {
          if ('error' in data) doc.error = data['error'] as string | null;
          if ('indexedAt' in data) doc.indexedAt = data['indexedAt'] as Date | null;
        }
        return { count: 1 };
      }),
    },
    aiSetting: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(settings, data);
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as unknown as Database;

  const knowledge = {
    forgetKind: vi.fn(async (_accountId: string, _propertyId: string, kind: string) => {
      const before = documents.length;
      for (let i = documents.length - 1; i >= 0; i -= 1) {
        if (documents[i]!.kind === kind) documents.splice(i, 1);
      }
      return before - documents.length;
    }),
    deleteDocument: vi.fn(async (_accountId: string, documentId: string) => {
      const index = documents.findIndex((doc) => doc.id === documentId);
      if (index >= 0) documents.splice(index, 1);
    }),
    syncLink: vi.fn(async () => ({ documentId: 'doc-1', changed: true })),
    indexDocument: vi.fn(async () => ({ chunks: 3 })),
  } as unknown as KnowledgeService;

  const enqueue = vi.fn(async () => undefined);
  const queue = { enqueue, enqueueOnce: vi.fn(async () => undefined) } as unknown as QueueProducer;

  return { db, knowledge, queue, enqueue, documents, settings };
}

const context: TenantContext = {
  accountId: 'acc-1',
  userId: 'user-1',
  memberId: 'mem-1',
  actorType: ActorType.USER,
  role: 'owner',
  permissions: new Set([Permission.AI_MANAGE, Permission.PROPERTY_VIEW]),
  requestId: 'req-1',
};

describe('KnowledgeSourceService.addLinks', () => {
  it('queues a job for each address and shows it as reading straight away', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.addLinks(context, 'prop-1', [
      'https://example.com/pricing',
      'https://example.com/delivery',
    ]);

    expect(result.queued).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(world.enqueue).toHaveBeenCalledTimes(2);
    expect(result.links.map((link) => link.status)).toEqual(['reading', 'reading']);
  });

  it('accepts an address typed without a scheme, and ignores a repeat in the same paste', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.addLinks(context, 'prop-1', [
      'example.com/pricing',
      'https://example.com/pricing',
    ]);

    expect(result.queued).toBe(1);
    expect(world.documents[0]?.url).toBe('https://example.com/pricing');
  });

  it('refuses an address with a port, and says so rather than calling it malformed', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.addLinks(context, 'prop-1', ['https://example.com:8080/pricing']);

    expect(result.queued).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/port number/);
  });

  it('refuses addresses that are not reachable from the internet, with the reason', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.addLinks(context, 'prop-1', [
      'http://localhost/admin',
      'http://127.0.0.1/secrets',
      'not a url at all',
      'https://good.example.com/page',
    ]);

    expect(result.queued).toBe(1);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected[0]?.reason).toMatch(/not reachable/);
  });

  it('lets a development environment add a local address, because that is what it is for', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({
      db: world.db,
      knowledge: world.knowledge,
      queue: world.queue,
      allowPrivateAddresses: true,
    });

    const result = await service.addLinks(context, 'prop-1', ['http://acme.test/pricing']);
    expect(result.queued).toBe(1);
  });

  it('re-reads an address that is already on the list instead of adding it twice', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    await service.addLinks(context, 'prop-1', ['https://example.com/pricing']);
    world.documents[0]!.indexedAt = new Date('2026-09-01T00:00:00Z');
    const again = await service.addLinks(context, 'prop-1', ['https://example.com/pricing']);

    expect(again.queued).toBe(1);
    expect(world.documents.filter((doc) => doc.url === 'https://example.com/pricing')).toHaveLength(1);
    // And it says so: an address being re-read must not sit there claiming to be indexed, or the
    // settings page never polls and a failed re-read is never seen.
    expect(again.links[0]?.status).toBe('reading');
  });

  it('stops at the limit and says why, rather than accepting pages it will not keep', async () => {
    const documents: Doc[] = Array.from({ length: MAX_LINKS_PER_PROPERTY }, (_, index) => ({
      id: `doc-${index}`,
      accountId: 'acc-1',
      propertyId: 'prop-1',
      kind: 'link',
      url: `https://example.com/page-${index}`,
      title: 'Page',
      error: null,
      chunkCount: 1,
      indexedAt: new Date(),
      createdAt: new Date(),
    }));
    const world = fixture({ documents });
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.addLinks(context, 'prop-1', ['https://example.com/one-too-many']);

    expect(result.queued).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/room for 100/);
  });
});

describe('KnowledgeSourceService.readLink', () => {
  it('indexes what it read', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({
      db: world.db,
      knowledge: world.knowledge,
      queue: world.queue,
      readPage: vi.fn(async () => ({
        url: 'https://example.com/pricing',
        title: 'Pricing',
        text: 'Growth is 29 a month.',
        description: null,
      })),
    });
    await service.addLinks(context, 'prop-1', ['https://example.com/pricing']);

    const outcome = await service.readLink('acc-1', 'prop-1', world.documents[0]!.id);

    expect(outcome.indexed).toBe(true);
    expect(world.knowledge.indexDocument).toHaveBeenCalled();
  });

  it('keeps the address the owner typed, not the one it redirected to', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({
      db: world.db,
      knowledge: world.knowledge,
      queue: world.queue,
      readPage: vi.fn(async () => ({
        url: 'https://example.com/pricing?session=abc',
        title: 'Pricing',
        text: 'Growth is 29 a month.',
        description: null,
      })),
    });
    await service.addLinks(context, 'prop-1', ['https://example.com/pricing']);

    await service.readLink('acc-1', 'prop-1', world.documents[0]!.id);

    expect(world.knowledge.syncLink).toHaveBeenCalledWith(
      'acc-1',
      'prop-1',
      expect.objectContaining({ url: 'https://example.com/pricing' }),
      expect.any(Date),
    );
  });

  it('writes the reason onto the page instead of failing the job', async () => {
    const world = fixture();
    const service = new KnowledgeSourceService({
      db: world.db,
      knowledge: world.knowledge,
      queue: world.queue,
      readPage: vi.fn(async () => {
        throw new Error('The page answered HTTP 404.');
      }),
    });
    await service.addLinks(context, 'prop-1', ['https://example.com/gone']);

    const outcome = await service.readLink('acc-1', 'prop-1', world.documents[0]!.id);

    expect(outcome.indexed).toBe(false);
    expect(world.documents[0]?.error).toBe('The page answered HTTP 404.');
    const links = await service.listLinks(context, 'prop-1');
    expect(links[0]?.status).toBe('failed');
  });
});

describe('KnowledgeSourceService.forget', () => {
  it('removes the feed products and the feed address with them', async () => {
    const world = fixture({
      documents: [
        { id: 'p1', accountId: 'acc-1', propertyId: 'prop-1', kind: 'product', url: 'https://shop.example.com/a', title: 'A', error: null, chunkCount: 1, indexedAt: new Date(), createdAt: new Date() },
      ],
    });
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    const result = await service.forget(context, 'prop-1', 'feed');

    expect(result.removed).toBe(1);
    expect(world.settings['productFeedUrl']).toBeNull();
    expect(world.settings['feedProducts']).toBe(0);
  });

  it('clears the key facts text as well as the passage it became', async () => {
    const world = fixture({
      documents: [
        { id: 'n1', accountId: 'acc-1', propertyId: 'prop-1', kind: 'notes', url: null, title: 'Key facts', error: null, chunkCount: 1, indexedAt: new Date(), createdAt: new Date() },
      ],
    });
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    await service.forget(context, 'prop-1', 'keyFacts');

    expect(world.settings['keyFacts']).toBe('');
  });

  it('resets the website counters so the page cannot claim pages it no longer has', async () => {
    const world = fixture({ settings: { crawlPagesFound: 42, crawlPagesIndexed: 40 } });
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    await service.forget(context, 'prop-1', 'website');

    expect(world.settings['crawlPagesFound']).toBe(0);
    expect(world.settings['crawlPagesIndexed']).toBe(0);
    expect(world.settings['lastCrawledAt']).toBeNull();
  });

  it('forgetting the added pages leaves the crawled ones alone', async () => {
    const world = fixture({
      documents: [
        { id: 'l1', accountId: 'acc-1', propertyId: 'prop-1', kind: 'link', url: 'https://other.example/spec', title: 'Spec', error: null, chunkCount: 2, indexedAt: new Date(), createdAt: new Date() },
        { id: 'g1', accountId: 'acc-1', propertyId: 'prop-1', kind: 'page', url: 'https://example.com/', title: 'Home', error: null, chunkCount: 5, indexedAt: new Date(), createdAt: new Date() },
      ],
    });
    const service = new KnowledgeSourceService({ db: world.db, knowledge: world.knowledge, queue: world.queue });

    await service.forget(context, 'prop-1', 'links');

    expect(world.documents.map((doc) => doc.kind)).toEqual(['page']);
  });
});
