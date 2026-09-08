import { describe, expect, it, vi } from 'vitest';
import { BillingReconcileService } from './reconcile.service.js';

const now = new Date('2026-09-08T12:00:00Z');
const clock = { now: () => now, timestamp: () => now.getTime() };
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

function harness(rows: Array<Record<string, unknown>>) {
  const subscriptions = rows.map((row, index) => ({
    id: `sub_${index}`,
    accountId: `acc_${index}`,
    status: 'active',
    pastDueSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    lockedAt: null,
    account: { deletedAt: null },
    ...row,
  }));
  const db = {
    subscription: {
      findMany: vi.fn(async () => subscriptions.map((s) => ({ ...s }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = subscriptions.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  };
  const deliver = vi.fn().mockResolvedValue(undefined);
  const service = new BillingReconcileService({
    db: db as never,
    brand: { productName: 'GetChat', appUrl: 'https://getchat.site', supportEmail: 'help@getchat.site' } as never,
    deliver,
    ownerOf: async (accountId) => ({ email: `${accountId}@example.com`, name: 'Owner' }),
    graceDays: async () => 3,
    clock,
  });
  return { service, subscriptions, deliver, db };
}

describe('BillingReconcileService', () => {
  it('locks and notifies an account whose grace window has closed, once', async () => {
    const h = harness([{ status: 'past_due', pastDueSince: daysAgo(4) }]);
    const first = await h.service.run();
    expect(first).toEqual({ examined: 1, newlyLocked: 1, notified: 1, unlocked: 0 });
    expect(h.subscriptions[0]?.lockedAt).toEqual(now);
    expect(h.deliver.mock.calls[0]?.[0].subject).toMatch(/locked/i);

    const second = await h.service.run();
    expect(second).toEqual({ examined: 1, newlyLocked: 0, notified: 0, unlocked: 0 });
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('leaves an account inside its grace window alone', async () => {
    const h = harness([{ status: 'past_due', pastDueSince: daysAgo(1) }]);
    expect(await h.service.run()).toEqual({ examined: 1, newlyLocked: 0, notified: 0, unlocked: 0 });
    expect(h.subscriptions[0]?.lockedAt).toBeNull();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('notifies an unpaid account straight away', async () => {
    const h = harness([{ status: 'unpaid' }]);
    expect(await h.service.run()).toMatchObject({ newlyLocked: 1, notified: 1 });
    expect(h.deliver.mock.calls[0]?.[0].text).toContain('not been paid');
  });

  it('clears a stale stamp on an account that is no longer locked', async () => {
    const h = harness([{ status: 'none', lockedAt: daysAgo(2) }]);
    expect(await h.service.run()).toEqual({ examined: 1, newlyLocked: 0, notified: 0, unlocked: 1 });
    expect(h.subscriptions[0]?.lockedAt).toBeNull();
  });

  it('skips accounts that have been deleted', async () => {
    const h = harness([{ status: 'unpaid', account: { deletedAt: daysAgo(1) } }]);
    expect(await h.service.run()).toEqual({ examined: 1, newlyLocked: 0, notified: 0, unlocked: 0 });
    expect(h.db.subscription.update).not.toHaveBeenCalled();
  });

  it('stamps before it emails, so a failed email does not repeat the lock', async () => {
    const h = harness([{ status: 'unpaid' }]);
    h.deliver.mockRejectedValueOnce(new Error('queue away'));
    await expect(h.service.run()).rejects.toThrow('queue away');
    expect(h.subscriptions[0]?.lockedAt).toEqual(now);
  });
});
