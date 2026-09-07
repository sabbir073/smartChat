import { describe, expect, it, vi } from 'vitest';
import { TeamService } from './team.service.js';

/**
 * Changing your status has to reach the widgets that are already open.
 *
 * Persisting the choice used to be the whole of `setAvailability`. The realtime gateway is a
 * different process from the API, so nothing told it anything: an agent came online and every
 * visitor already sitting on the site went on being shown the offline form until they reloaded
 * the page. "Immediately" is the entire feature.
 */
function serviceWith(announce?: (accountId: string) => Promise<void>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const service = new TeamService({
    db: { accountMember: { updateMany } } as never,
    mailer: { name: 'test', send: vi.fn() } as never,
    brand: { productName: 'Test', appUrl: 'https://test.example' },
    ...(announce ? { announceAvailability: announce } : {}),
  });
  return { service, updateMany };
}

const context = {
  accountId: 'acc_1',
  memberId: 'mem_1',
  userId: 'usr_1',
  permissions: new Set<string>(),
} as never;

describe('TeamService.setAvailability', () => {
  it('announces the change after persisting it', async () => {
    const order: string[] = [];
    const announce = vi.fn(async (accountId: string) => {
      order.push(`announce:${accountId}`);
    });
    const { service, updateMany } = serviceWith(announce);
    updateMany.mockImplementation(async () => {
      order.push('persist');
      return { count: 1 };
    });

    await service.setAvailability(context, 'online');

    expect(order).toEqual(['persist', 'announce:acc_1']);
  });

  it('announces for away and offline too, not only when coming online', async () => {
    const announce = vi.fn().mockResolvedValue(undefined);
    const { service } = serviceWith(announce);

    await service.setAvailability(context, 'away');
    await service.setAvailability(context, 'offline');

    expect(announce).toHaveBeenCalledTimes(2);
  });

  /** The choice is already saved. A broadcast that fails must not turn that into an error. */
  it('does not fail the change when the announcement fails', async () => {
    const announce = vi.fn().mockRejectedValue(new Error('redis is down'));
    const { service, updateMany } = serviceWith(announce);

    await expect(service.setAvailability(context, 'online')).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalled();
  });

  it('works without an announcer at all', async () => {
    const { service } = serviceWith();
    await expect(service.setAvailability(context, 'online')).resolves.toBeUndefined();
  });
});
