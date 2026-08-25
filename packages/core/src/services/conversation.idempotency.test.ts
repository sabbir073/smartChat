import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@smartchat/database';
import { ConversationService } from './conversation.service.js';

/**
 * The retry guarantee, pinned.
 *
 * A visitor whose acknowledgement was lost resends the same message with the same
 * `clientMessageId`. That must produce the message that already exists - not a duplicate, and not
 * an error.
 *
 * The failure this test exists to prevent: recovering *inside* the transaction. Postgres aborts a
 * transaction the instant a constraint is violated, so every subsequent statement on that
 * connection fails with 25P02 ("current transaction is aborted") and the recovery read can never
 * run. The fake below reproduces exactly that behaviour, so a regression fails here rather than in
 * production on a flaky network.
 */

const CONVERSATION_ID = '11111111-1111-7111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-7222-8222-222222222222';
const PROPERTY_ID = '33333333-3333-7333-8333-333333333333';
const VISITOR_ID = '44444444-4444-7444-8444-444444444444';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['conversation_id', 'client_message_id'] },
  });
}

function abortedTransaction() {
  return new Prisma.PrismaClientUnknownRequestError(
    'current transaction is aborted, commands ignored until end of transaction block',
    { clientVersion: 'test' },
  );
}

/**
 * A Prisma double that behaves the way Postgres actually behaves: once a statement inside a
 * transaction fails, every later statement in that transaction fails too.
 */
function createDatabase(options: { existingMessage: unknown; conversation: unknown }) {
  const state = { poisoned: false, createCalls: 0, seq: 1 };

  const guard = <T>(result: () => T): T => {
    if (state.poisoned) throw abortedTransaction();
    return result();
  };

  const db = {
    message: {
      create: vi.fn(async () => {
        state.createCalls += 1;
        if (state.poisoned) throw abortedTransaction();
        // Inside a transaction the unique index rejects the duplicate and poisons the transaction.
        state.poisoned = true;
        throw uniqueViolation();
      }),
      findFirst: vi.fn(async () => guard(() => options.existingMessage)),
      findMany: vi.fn(async () => guard(() => [])),
    },
    conversation: {
      update: vi.fn(async () =>
        guard(() => ({ ...(options.conversation as object), messageSeq: BigInt(++state.seq) })),
      ),
      findUnique: vi.fn(async () => guard(() => options.conversation)),
      findFirst: vi.fn(async () => guard(() => options.conversation)),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn(db);
      } finally {
        // Whatever happened, the transaction has ended - so the connection is usable again.
        state.poisoned = false;
      }
    }),
    state,
  };
  return db;
}

describe('a resent message', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  const conversation = {
    id: CONVERSATION_ID,
    accountId: ACCOUNT_ID,
    propertyId: PROPERTY_ID,
    visitorId: VISITOR_ID,
    status: 'open',
    messageSeq: BigInt(1),
    deletedAt: null,
  };

  const existingMessage = {
    id: '55555555-5555-7555-8555-555555555555',
    conversationId: CONVERSATION_ID,
    seq: BigInt(1),
    clientMessageId: 'RETRY-ME',
    senderType: 'visitor',
    senderMemberId: null,
    senderVisitorId: VISITOR_ID,
    type: 'text',
    body: 'Hello?',
    metadata: {},
    createdAt: now,
    readAt: null,
    deletedAt: null,
  };

  const identity = {
    accountId: ACCOUNT_ID,
    propertyId: PROPERTY_ID,
    visitorId: VISITOR_ID,
    sessionId: '66666666-6666-7666-8666-666666666666',
    visitorName: null,
    visitor: { name: null },
  };

  function service(db: unknown) {
    return new ConversationService({
      db: db as never,
      events: { publish: vi.fn(async () => undefined) },
      clock: { now: () => now },
    } as never);
  }

  it('returns the stored message instead of failing, when the pre-check finds it', async () => {
    const db = createDatabase({ existingMessage, conversation });
    const result = await service(db).sendVisitorMessage(identity as never, CONVERSATION_ID, {
      clientMessageId: 'RETRY-ME',
      body: 'Hello?',
      type: 'text',
    } as never);

    expect(result.created).toBe(false);
    expect(result.message.id).toBe(existingMessage.id);
    // The whole point: no insert was attempted, so no sequence number was burned.
    expect(db.state.createCalls).toBe(0);
  });

  it('recovers after losing the race, reading only once the transaction has ended', async () => {
    let visible: unknown = null;
    const db = createDatabase({
      // Invisible to the pre-check, visible afterwards: the twin retry committed in between.
      get existingMessage() {
        return visible;
      },
      conversation,
    });
    db.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn(db);
      } catch (error) {
        visible = existingMessage;
        throw error;
      } finally {
        db.state.poisoned = false;
      }
    }) as never;

    const result = await service(db).sendVisitorMessage(identity as never, CONVERSATION_ID, {
      clientMessageId: 'RETRY-ME',
      body: 'Hello?',
      type: 'text',
    } as never);

    expect(result.created).toBe(false);
    expect(result.message.id).toBe(existingMessage.id);
    expect(db.state.createCalls).toBe(1);
  });
});
