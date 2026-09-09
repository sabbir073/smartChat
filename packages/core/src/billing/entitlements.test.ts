import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@smartchat/types';
import { EntitlementService } from './entitlements.js';

const now = new Date('2026-09-08T12:00:00Z');
const clock = { now: () => now, timestamp: () => now.getTime() };

function plan(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'plan_free',
    key: 'free',
    name: 'Free',
    maxProperties: 1,
    maxMembers: 1,
    aiAgent: false,
    integrations: false,
    removeBranding: false,
    aiOwnKey: false,
    isContactSales: false,
    ...overrides,
  };
}

function serviceWith(opts: {
  plan?: ReturnType<typeof plan>;
  status?: string;
  properties?: number;
  members?: number;
  pastDueSince?: Date | null;
}) {
  const subscription = {
    status: opts.status ?? 'none',
    interval: 'month',
    provider: 'manual',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: opts.pastDueSince ?? null,
    lockedAt: null,
    plan: opts.plan ?? plan(),
  };
  const findUnique = vi.fn().mockResolvedValue(subscription);
  const db = {
    subscription: { findUnique },
    property: { count: vi.fn().mockResolvedValue(opts.properties ?? 0) },
    accountMember: { count: vi.fn().mockResolvedValue(opts.members ?? 0) },
  };
  return {
    service: new EntitlementService({ db: db as never, graceDays: async () => 3, clock }),
    findUnique,
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe('EntitlementService limits', () => {
  it('allows a website while under the plan ceiling', async () => {
    const { service } = serviceWith({ properties: 0 });
    await expect(service.assertCanAddProperty('acc')).resolves.toBeUndefined();
  });

  it('refuses a website at the ceiling, naming the plan and the number', async () => {
    const { service } = serviceWith({ properties: 1 });
    try {
      await service.assertCanAddProperty('acc');
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCode.PLAN_LIMIT_REACHED);
      expect((error as Error).message).toContain('Free plan includes 1 website');
    }
  });

  it('counts pending invitations as seats', async () => {
    const { service } = serviceWith({ plan: plan({ maxMembers: 5 }), members: 5 });
    expect(await codeOf(() => service.assertCanInviteMember('acc'))).toBe(
      ErrorCode.PLAN_LIMIT_REACHED,
    );
  });

  it('treats a null limit as unlimited', async () => {
    const { service } = serviceWith({
      plan: plan({ maxProperties: null, maxMembers: null }),
      properties: 999,
      members: 999,
    });
    await expect(service.assertCanAddProperty('acc')).resolves.toBeUndefined();
    await expect(service.assertCanInviteMember('acc')).resolves.toBeUndefined();
  });
});

describe('EntitlementService features', () => {
  it('gates a feature the plan does not include', async () => {
    const { service } = serviceWith({});
    expect(await codeOf(() => service.assertFeature('acc', 'aiAgent'))).toBe(
      ErrorCode.FEATURE_NOT_IN_PLAN,
    );
    expect(await service.hasFeature('acc', 'integrations')).toBe(false);
  });

  it('lets a feature through when the plan includes it', async () => {
    const { service } = serviceWith({ plan: plan({ aiAgent: true, integrations: true }) });
    await expect(service.assertFeature('acc', 'aiAgent')).resolves.toBeUndefined();
    expect(await service.hasFeature('acc', 'integrations')).toBe(true);
  });
});

describe('EntitlementService lock', () => {
  it('does not lock an active account', async () => {
    const { service } = serviceWith({ status: 'active' });
    await expect(service.assertNotLocked('acc')).resolves.toBeUndefined();
  });

  it('locks an unpaid account with the billing code', async () => {
    const { service } = serviceWith({ status: 'unpaid' });
    expect(await codeOf(() => service.assertNotLocked('acc'))).toBe(ErrorCode.BILLING_LOCKED);
  });

  /** A downgrade leaves the extras in place; the dashboard locks until the account fits again. */
  it('locks an account that has more websites than its plan allows', async () => {
    const { service } = serviceWith({ properties: 3 });
    const { lock, usage } = await service.forAccount('acc');
    expect(lock).toEqual({ locked: true, reason: 'over_limit', graceEndsAt: null });
    expect(usage).toEqual({ properties: 3, members: 0 });
  });

  it('does not count an account at exactly its limit as over it', async () => {
    const { service } = serviceWith({ properties: 1, members: 1 });
    const { lock } = await service.forAccount('acc');
    expect(lock.locked).toBe(false);
  });

  it('reports the grace window on a past-due account without locking yet', async () => {
    const { service } = serviceWith({ status: 'past_due', pastDueSince: now });
    const { lock } = await service.forAccount('acc');
    expect(lock.locked).toBe(false);
    expect(lock.graceEndsAt).not.toBeNull();
  });
});

describe('EntitlementService cache', () => {
  it('reads the plan once within the window, and again after invalidation', async () => {
    const { service, findUnique } = serviceWith({});
    await service.forAccount('acc');
    await service.forAccount('acc');
    expect(findUnique).toHaveBeenCalledTimes(1);

    service.invalidate('acc');
    await service.forAccount('acc');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('keeps accounts apart', async () => {
    const { service, findUnique } = serviceWith({});
    await service.forAccount('a');
    await service.forAccount('b');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  /** A missing row is a bug, and it must surface as one rather than as a silent "free plan". */
  it('refuses to invent entitlements for an account with no subscription row', async () => {
    const { service, findUnique } = serviceWith({});
    findUnique.mockResolvedValue(null);
    expect(await codeOf(() => service.forAccount('acc'))).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
