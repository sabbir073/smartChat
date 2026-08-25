import {
  PRESENCE_TTL_SECONDS,
  TYPING_TTL_SECONDS,
  presenceKey,
  type AgentAvailability,
} from '@smartchat/types';
import type { RedisClient } from '../redis/client.js';

/**
 * Presence and typing state.
 *
 * Deliberately in Redis with a TTL rather than in Postgres. It is ephemeral, extremely
 * write-heavy, and worthless after a restart - a process that dies without saying goodbye must
 * simply expire, not leave an agent showing as online forever. Persisted *availability* (the
 * deliberate online/away choice) is a different thing and lives on the membership row.
 */
export interface AgentPresence {
  memberId: string;
  status: AgentAvailability;
  updatedAt: number;
}

export interface VisitorPresence {
  visitorId: string;
  url: string | null;
  title: string | null;
  updatedAt: number;
}

export class PresenceService {
  constructor(private readonly redis: RedisClient) {}

  // --- agents ---------------------------------------------------------------

  async setAgentOnline(
    accountId: string,
    memberId: string,
    status: AgentAvailability,
    now: number,
  ): Promise<void> {
    const key = presenceKey.agent(accountId, memberId);
    await this.redis
      .multi()
      .set(key, JSON.stringify({ memberId, status, updatedAt: now }), 'EX', PRESENCE_TTL_SECONDS)
      .sadd(presenceKey.agentSet(accountId), memberId)
      .exec();
  }

  async setAgentOffline(accountId: string, memberId: string): Promise<void> {
    await this.redis
      .multi()
      .del(presenceKey.agent(accountId, memberId))
      .srem(presenceKey.agentSet(accountId), memberId)
      .exec();
  }

  /**
   * Every agent currently present for an account.
   *
   * The set is the index and the individual keys are the truth: a key that has expired without its
   * set entry being removed is pruned here, so a crashed process cannot leave a permanent ghost.
   */
  async listAgents(accountId: string): Promise<AgentPresence[]> {
    const memberIds = await this.redis.smembers(presenceKey.agentSet(accountId));
    if (memberIds.length === 0) return [];

    const values = await this.redis.mget(
      memberIds.map((memberId) => presenceKey.agent(accountId, memberId)),
    );

    const present: AgentPresence[] = [];
    const stale: string[] = [];

    memberIds.forEach((memberId, index) => {
      const raw = values[index];
      if (!raw) {
        stale.push(memberId);
        return;
      }
      try {
        present.push(JSON.parse(raw) as AgentPresence);
      } catch {
        stale.push(memberId);
      }
    });

    if (stale.length > 0) {
      await this.redis.srem(presenceKey.agentSet(accountId), ...stale).catch(() => undefined);
    }
    return present;
  }

  /** Is anyone available to take a chat right now? Drives the widget's online/offline state. */
  async hasAvailableAgent(accountId: string): Promise<boolean> {
    const agents = await this.listAgents(accountId);
    return agents.some((agent) => agent.status === 'online');
  }

  // --- visitors -------------------------------------------------------------

  async setVisitorOnline(
    propertyId: string,
    visitorId: string,
    page: { url: string | null; title: string | null },
    now: number,
  ): Promise<void> {
    await this.redis
      .multi()
      .set(
        presenceKey.visitor(propertyId, visitorId),
        JSON.stringify({ visitorId, ...page, updatedAt: now }),
        'EX',
        PRESENCE_TTL_SECONDS,
      )
      .sadd(presenceKey.visitorSet(propertyId), visitorId)
      .exec();
  }

  async setVisitorOffline(propertyId: string, visitorId: string): Promise<void> {
    await this.redis
      .multi()
      .del(presenceKey.visitor(propertyId, visitorId))
      .srem(presenceKey.visitorSet(propertyId), visitorId)
      .exec();
  }

  async listVisitors(propertyId: string): Promise<VisitorPresence[]> {
    const ids = await this.redis.smembers(presenceKey.visitorSet(propertyId));
    if (ids.length === 0) return [];

    const values = await this.redis.mget(
      ids.map((visitorId) => presenceKey.visitor(propertyId, visitorId)),
    );

    const present: VisitorPresence[] = [];
    const stale: string[] = [];

    ids.forEach((visitorId, index) => {
      const raw = values[index];
      if (!raw) {
        stale.push(visitorId);
        return;
      }
      try {
        present.push(JSON.parse(raw) as VisitorPresence);
      } catch {
        stale.push(visitorId);
      }
    });

    if (stale.length > 0) {
      await this.redis.srem(presenceKey.visitorSet(propertyId), ...stale).catch(() => undefined);
    }
    return present;
  }

  // --- typing ---------------------------------------------------------------

  /**
   * Typing state is a short-lived key rather than an event pair.
   *
   * "Started typing" without a matching "stopped" is the normal case - people close tabs - so a
   * TTL is the only representation that cannot get stuck on.
   */
  async setTyping(conversationId: string, actorId: string): Promise<void> {
    await this.redis.set(
      presenceKey.typing(conversationId, actorId),
      '1',
      'EX',
      TYPING_TTL_SECONDS,
    );
  }

  async clearTyping(conversationId: string, actorId: string): Promise<void> {
    await this.redis.del(presenceKey.typing(conversationId, actorId));
  }

  async isTyping(conversationId: string, actorId: string): Promise<boolean> {
    return (await this.redis.exists(presenceKey.typing(conversationId, actorId))) === 1;
  }
}
