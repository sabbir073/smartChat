import { describe, expect, it } from 'vitest';
import { presenceKey } from '@smartchat/types';
import { PresenceService } from './presence.js';
import type { RedisClient } from '../redis/client.js';

/**
 * Viewer presence is what puts "Sabbir has this chat open" under a row in somebody else's inbox,
 * so the cases worth pinning are the ones where a name would otherwise be wrong: a member with
 * two tabs, and a tab that died without saying goodbye.
 *
 * The fake is deliberately small - just the commands this service uses - and keeps no TTLs. A key
 * is "expired" in these tests by deleting it and leaving the index entry behind, which is exactly
 * the state Redis is in after a TTL passes.
 */
function fakeRedis() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const queue: Array<() => void> = [];
  const client = {
    multi() {
      const chain = {
        set(key: string, value: string) {
          queue.push(() => values.set(key, value));
          return chain;
        },
        sadd(key: string, member: string) {
          queue.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            set.add(member);
            sets.set(key, set);
          });
          return chain;
        },
        del(key: string) {
          queue.push(() => values.delete(key));
          return chain;
        },
        srem(key: string, member: string) {
          queue.push(() => sets.get(key)?.delete(member));
          return chain;
        },
        async exec() {
          while (queue.length > 0) queue.shift()!();
          return [];
        },
      };
      return chain;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async mget(keys: string[]) {
      return keys.map((key) => values.get(key) ?? null);
    },
    async srem(key: string, ...members: string[]) {
      for (const member of members) sets.get(key)?.delete(member);
      return members.length;
    },
    async expire(key: string, _seconds: number) {
      return values.has(key) ? 1 : 0;
    },
  };

  return {
    client: client as unknown as RedisClient,
    /** What a TTL does: the value goes, the index entry is left behind. */
    expire: (key: string) => values.delete(key),
    values,
    sets,
  };
}

const ACCOUNT = 'acc-1';

function viewer(overrides: Partial<Parameters<PresenceService['setViewer']>[2]> = {}) {
  return {
    conversationId: 'conv-1',
    propertyId: 'prop-1',
    memberId: 'mem-1',
    name: 'Sabbir',
    avatarUrl: null,
    ...overrides,
  };
}

describe('PresenceService viewers', () => {
  it('records who has a conversation open and reads it back', async () => {
    const redis = fakeRedis();
    const presence = new PresenceService(redis.client);

    await presence.setViewer(ACCOUNT, 'socket-a', viewer());

    expect(await presence.listViewers(ACCOUNT)).toEqual([viewer()]);
  });

  it('keeps one entry per socket, so a second tab does not overwrite the first', async () => {
    const redis = fakeRedis();
    const presence = new PresenceService(redis.client);

    await presence.setViewer(ACCOUNT, 'socket-a', viewer({ conversationId: 'conv-1' }));
    await presence.setViewer(ACCOUNT, 'socket-b', viewer({ conversationId: 'conv-2' }));

    const all = await presence.listViewers(ACCOUNT);
    expect(all.map((entry) => entry.conversationId).sort()).toEqual(['conv-1', 'conv-2']);
  });

  it('moves a socket from one conversation to another rather than leaving it on both', async () => {
    const redis = fakeRedis();
    const presence = new PresenceService(redis.client);

    await presence.setViewer(ACCOUNT, 'socket-a', viewer({ conversationId: 'conv-1' }));
    await presence.setViewer(ACCOUNT, 'socket-a', viewer({ conversationId: 'conv-2' }));

    expect(await presence.listViewers(ACCOUNT)).toEqual([viewer({ conversationId: 'conv-2' })]);
  });

  it('forgets a viewer when the tab says goodbye', async () => {
    const redis = fakeRedis();
    const presence = new PresenceService(redis.client);

    await presence.setViewer(ACCOUNT, 'socket-a', viewer());
    await presence.clearViewer(ACCOUNT, 'socket-a');

    expect(await presence.listViewers(ACCOUNT)).toEqual([]);
    expect(redis.sets.get(presenceKey.viewerSet(ACCOUNT))?.size ?? 0).toBe(0);
  });

  it('prunes a viewer whose key expired because the browser died', async () => {
    const redis = fakeRedis();
    const presence = new PresenceService(redis.client);

    await presence.setViewer(ACCOUNT, 'socket-a', viewer({ memberId: 'mem-1' }));
    await presence.setViewer(ACCOUNT, 'socket-b', viewer({ memberId: 'mem-2', name: 'Nayeem' }));
    redis.expire(presenceKey.viewer(ACCOUNT, 'socket-a'));

    const all = await presence.listViewers(ACCOUNT);
    expect(all.map((entry) => entry.memberId)).toEqual(['mem-2']);
    // And the index no longer carries the ghost, so it costs nothing on the next read either.
    expect([...(redis.sets.get(presenceKey.viewerSet(ACCOUNT)) ?? [])]).toEqual(['socket-b']);
  });

  it('answers with nothing for an account where nobody is reading anything', async () => {
    const presence = new PresenceService(fakeRedis().client);
    expect(await presence.listViewers('quiet-account')).toEqual([]);
  });
});
