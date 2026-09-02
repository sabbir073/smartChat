import type { Database } from '@smartchat/database';
import type { StorageService } from '../storage/storage.service.js';
import { systemClock, type Clock } from '../time.js';
import { FeatureKey } from '@smartchat/types';
import type { EntitlementService } from './entitlement.service.js';

/**
 * Data retention.
 *
 * `Account.dataRetentionDays` has existed since phase 1 and, until now, did nothing - the job that
 * was supposed to honour it logged "nothing to apply yet". That is the worst kind of unimplemented
 * feature: not a gap somebody can see, but a **promise in the product** that quietly is not kept.
 * An account that set 90 days believed its customers' conversations were being deleted. They were
 * not.
 *
 * What this deletes, and what it deliberately does not:
 *
 * - **Conversations** whose last message is older than the window, and everything that hangs off
 *   them: messages, attachments, read markers. The transcript is the personal data.
 * - **Visitors** with no remaining conversations and no contact link, because a visitor row with
 *   nothing attached is a browser fingerprint and an IP with no purpose left.
 * - **Not tickets.** A ticket is a commercial record - what was asked for and what was promised -
 *   and deleting it because a chat aged out would destroy the account's own history of its
 *   obligations. If a ticket should expire, that is a separate window and a separate decision.
 * - **Not the audit log.** It exists to answer questions about the past, and a retention policy
 *   that erased the record of its own operation would be self-defeating.
 * - **Not contacts.** A person is not a conversation. Erasing an individual is a different act,
 *   done deliberately and one person at a time.
 */

export interface RetentionServiceOptions {
  db: Database;
  /** Optional: without it, the rows go and the objects behind them do not. See `deleteObjects`. */
  storage?: StorageService;
  /**
   * The plan's cap on how far back conversation history goes.
   *
   * Required, because `max_conversation_history_days` is sold on the pricing page - Free keeps
   * ninety days, Pro keeps everything - and before this it was enforced nowhere. An account could
   * set its own retention to null and keep history for ever on a plan that does not include it,
   * which made the number on the pricing page decoration.
   */
  entitlements: EntitlementService;
  clock?: Clock;
}

export interface RetentionOutcome {
  accountsConsidered: number;
  conversationsDeleted: number;
  visitorsDeleted: number;
  objectsDeleted: number;
  objectsOrphaned: number;
}

/**
 * How many conversations to remove per statement.
 *
 * Small enough that the transaction holds its locks for a short time and a busy account's inbox
 * stays responsive while its history is being pruned; large enough that a year of backlog is
 * cleared in minutes rather than days.
 */
const BATCH = 200;

/** A ceiling per run, so one enormous account cannot monopolise the nightly job. */
const MAX_PER_ACCOUNT_PER_RUN = 20_000;

export class RetentionService {
  private readonly clock: Clock;

  constructor(private readonly options: RetentionServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async apply(): Promise<RetentionOutcome> {
    // Every account, not only those with a policy of their own: the plan can impose one.
    const accounts = await this.options.db.account.findMany({
      where: { deletedAt: null },
      select: { id: true, dataRetentionDays: true },
    });

    const outcome: RetentionOutcome = {
      accountsConsidered: accounts.length,
      conversationsDeleted: 0,
      visitorsDeleted: 0,
      objectsDeleted: 0,
      objectsOrphaned: 0,
    };

    for (const account of accounts) {
      /**
       * The shorter of what the account asked for and what its plan includes.
       *
       * Both are real policies and they answer different questions. The account's own setting is
       * a privacy promise it made to its customers; the plan's cap is what it is paying to keep.
       * Whichever is shorter wins, because honouring the longer one would break the other.
       */
      const planCap = await this.options.entitlements.limit(
        account.id,
        FeatureKey.MAX_CONVERSATION_HISTORY_DAYS,
      );
      const candidates = [account.dataRetentionDays, planCap].filter(
        (value): value is number => typeof value === 'number' && value >= 1,
      );
      const days = candidates.length > 0 ? Math.min(...candidates) : null;

      // Belt and braces: a zero or negative window would delete everything, including the
      // conversation somebody is having right now. A policy that aggressive has to be a
      // deliberate act somewhere else, not an accident of an unvalidated column.
      if (!days || days < 1) continue;

      const cutoff = new Date(this.clock.now().getTime() - days * 24 * 60 * 60 * 1000);
      const result = await this.pruneAccount(account.id, cutoff);
      outcome.conversationsDeleted += result.conversationsDeleted;
      outcome.visitorsDeleted += result.visitorsDeleted;
      outcome.objectsDeleted += result.objectsDeleted;
      outcome.objectsOrphaned += result.objectsOrphaned;
    }

    return outcome;
  }

  private async pruneAccount(
    accountId: string,
    cutoff: Date,
  ): Promise<Omit<RetentionOutcome, 'accountsConsidered'>> {
    let conversationsDeleted = 0;
    let objectsDeleted = 0;
    let objectsOrphaned = 0;

    while (conversationsDeleted < MAX_PER_ACCOUNT_PER_RUN) {
      const batch = await this.options.db.conversation.findMany({
        where: { accountId, lastMessageAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (batch.length === 0) break;
      const ids = batch.map((row) => row.id);

      /**
       * The object keys are collected **before** the rows go.
       *
       * Once the attachment rows are deleted there is nothing left that knows which objects
       * belonged to them, and an object store full of unreferenced files is a bill nobody can
       * explain and a pile of personal data nobody can find.
       */
      const attachments = await this.options.db.attachment.findMany({
        where: { accountId, conversationId: { in: ids } },
        select: { storageKey: true },
      });
      const keys = attachments.map((row) => row.storageKey).filter((key) => key.length > 0);

      // The rows first. A failure to delete an object must not stop the deletion of the personal
      // data it points at - an orphaned file is a smaller problem than a retained transcript.
      await this.options.db.conversation.deleteMany({ where: { accountId, id: { in: ids } } });
      conversationsDeleted += ids.length;

      const removed = await this.deleteObjects(keys);
      objectsDeleted += removed;
      objectsOrphaned += keys.length - removed;
    }

    /**
     * Visitors left with nothing.
     *
     * A visitor row is a browser: a fingerprint, a user agent, an IP, a language. With no
     * conversations left and no contact behind it, it is personal data with no purpose - so it
     * goes too. One that still belongs to a contact stays, because the contact is the account's
     * own customer record and deleting it is a different decision.
     */
    const orphaned = await this.options.db.visitor.deleteMany({
      where: {
        accountId,
        contactId: null,
        lastSeenAt: { lt: cutoff },
        conversations: { none: {} },
      },
    });

    return {
      conversationsDeleted,
      visitorsDeleted: orphaned.count,
      objectsDeleted,
      objectsOrphaned,
    };
  }

  /**
   * Remove the files behind deleted attachments.
   *
   * Returns how many actually went. Without a storage service - a deployment that has not wired
   * one into the worker - every key is counted as orphaned and reported, because "we deleted the
   * rows and left the files" is something an operator has to be told rather than left to discover
   * from a storage bill.
   */
  private async deleteObjects(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const storage = this.options.storage;
    if (!storage) return 0;

    let deleted = 0;
    for (const key of keys) {
      try {
        await storage.delete(key);
        deleted += 1;
      } catch {
        // Counted as orphaned by the caller. Retrying here would risk the whole batch for a file.
      }
    }
    return deleted;
  }
}
