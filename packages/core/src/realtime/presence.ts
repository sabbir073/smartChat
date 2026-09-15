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

/** One member with one conversation open, as one socket sees it. */
export interface ConversationViewer {
  conversationId: string;
  propertyId: string;
  memberId: string;
  name: string;
  avatarUrl: string | null;
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

  /**
   * There used to be a `hasAvailableAgent` here, answering "is anybody available" from these
   * presence keys. It is gone deliberately rather than left unused.
   *
   * Presence is written only while an agent holds an open socket, and the dashboard opens one on
   * the Inbox page and nowhere else — so this answered "is somebody looking at the inbox right
   * now", which is a different question from the one four call sites were asking. Meanwhile the
   * availability control wrote the agent's actual choice to the membership row, which nothing
   * here read. Deleting it is the point: `agentAvailabilityReader` is now the only way to ask,
   * so the two answers cannot drift apart again.
   */

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

  // --- who has a conversation open ------------------------------------------

  /**
   * This socket is looking at this conversation.
   *
   * One key per socket, overwritten rather than added to, because a dashboard shows one
   * conversation at a time: opening a second one is leaving the first. The key expires on the
   * same TTL as agent presence and is refreshed by the same heartbeat, so a tab that dies without
   * saying goodbye stops being a viewer within a minute instead of forever.
   */
  async setViewer(accountId: string, socketId: string, viewer: ConversationViewer): Promise<void> {
    await this.redis
      .multi()
      .set(presenceKey.viewer(accountId, socketId), JSON.stringify(viewer), 'EX', PRESENCE_TTL_SECONDS)
      .sadd(presenceKey.viewerSet(accountId), socketId)
      .exec();
  }

  /** Keep this socket's viewer entry alive. Called on the agent heartbeat. */
  async touchViewer(accountId: string, socketId: string): Promise<void> {
    await this.redis.expire(presenceKey.viewer(accountId, socketId), PRESENCE_TTL_SECONDS);
  }

  async clearViewer(accountId: string, socketId: string): Promise<void> {
    await this.redis
      .multi()
      .del(presenceKey.viewer(accountId, socketId))
      .srem(presenceKey.viewerSet(accountId), socketId)
      .exec();
  }

  /**
   * Everyone in this account with a conversation open, one entry per socket.
   *
   * Entries whose key has expired are pruned from the index as they are found, the same way agent
   * presence does it, so a crashed gateway cannot leave a name on somebody's screen for good.
   */
  async listViewers(accountId: string): Promise<ConversationViewer[]> {
    const socketIds = await this.redis.smembers(presenceKey.viewerSet(accountId));
    if (socketIds.length === 0) return [];

    const values = await this.redis.mget(
      socketIds.map((socketId) => presenceKey.viewer(accountId, socketId)),
    );

    const viewers: ConversationViewer[] = [];
    const stale: string[] = [];

    socketIds.forEach((socketId, index) => {
      const raw = values[index];
      if (!raw) {
        stale.push(socketId);
        return;
      }
      try {
        viewers.push(JSON.parse(raw) as ConversationViewer);
      } catch {
        stale.push(socketId);
      }
    });

    if (stale.length > 0) {
      await this.redis.srem(presenceKey.viewerSet(accountId), ...stale).catch(() => undefined);
    }
    return viewers;
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
}
