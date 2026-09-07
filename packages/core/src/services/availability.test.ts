import { describe, expect, it, vi } from 'vitest';
import { agentAvailabilityReader } from './availability.js';

function dbWith(findFirst: ReturnType<typeof vi.fn>) {
  return { accountMember: { findFirst } } as never;
}

/**
 * The bug this pins.
 *
 * The availability control writes the chosen status to the membership row over HTTP. "Is anybody
 * available", which decides whether a visitor is offered a live chat or an offline form, used to
 * be computed from Redis presence instead — and presence is only written while an agent holds an
 * open socket to the realtime gateway, which the dashboard opens on the Inbox page and nowhere
 * else. So the control wrote to a store nothing read, the widget read a store the control never
 * wrote, and the answer was "offline" no matter what anybody picked.
 */
describe('agentAvailabilityReader', () => {
  it('reads the choice an agent actually made, not whether a socket is open', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'mem_1' });
    expect(await agentAvailabilityReader(dbWith(findFirst))('acc_1')).toBe(true);

    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ accountId: 'acc_1', availability: 'online' });
  });

  it('says nobody is available when nobody chose online', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    expect(await agentAvailabilityReader(dbWith(findFirst))('acc_1')).toBe(false);
  });

  /** Away is a deliberate "not now". It must not read as available. */
  it('only counts online, never away', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await agentAvailabilityReader(dbWith(findFirst))('acc_1');
    expect(findFirst.mock.calls[0]?.[0]?.where?.availability).toBe('online');
  });

  it('ignores members who are suspended, removed, or whose user is gone', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await agentAvailabilityReader(dbWith(findFirst))('acc_1');
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      status: 'active',
      deletedAt: null,
      user: { deletedAt: null },
    });
  });

  it('never leaks across accounts', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await agentAvailabilityReader(dbWith(findFirst))('acc_2');
    expect(findFirst.mock.calls[0]?.[0]?.where?.accountId).toBe('acc_2');
  });
});
