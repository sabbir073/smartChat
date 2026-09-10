import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@smartchat/database';
import type { EntitlementService } from '../billing/entitlements.js';
import type { QueueProducer } from '../queue/producer.js';
import type { EventPublisher } from '../realtime/events.js';
import type { Clock } from '../time.js';
import { LifecycleService } from './lifecycle.service.js';

/**
 * A stand-in for the handful of Prisma calls the lifecycle makes, so the rules - stale timers do
 * nothing, a person who replied keeps the chat, a visitor who came back is not closed on - can
 * be pinned without a database. The end-to-end run covers the real one.
 */

interface FakeState {
  conversation: Record<string, unknown> & {
    id: string;
    accountId: string;
    propertyId: string;
    visitorId: string;
    status: string;
    priority: string;
    tags: string[];
    channel: string;
    assignedMemberId: string | null;
    aiPausedAt: Date | null;
    aiHandoffAt: Date | null;
    aiFollowupSeq: number;
    aiIdleNudgedAt: Date | null;
    aiReplyCount: number;
    lastVisitorMessageAt: Date | null;
    startedAt: Date;
    deletedAt: Date | null;
    messageSeq: bigint;
    closedAt: Date | null;
    closedByMemberId: string | null;
  };
  settings: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  onlineAgents: boolean;
}

function fakeDb(state: FakeState): Database {
  const conversation = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt?: null } }) =>
      where.id === state.conversation.id && !state.conversation.deletedAt ? { ...state.conversation } : null,
    ),
    update: vi.fn(async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in (value as object)) {
          const current = state.conversation[key];
          const step = (value as { increment: number }).increment;
          state.conversation[key] = typeof current === 'bigint' ? current + BigInt(step) : (current as number) + step;
        } else {
          state.conversation[key] = value;
        }
      }
      if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, state.conversation[k]]));
      return { ...state.conversation };
    }),
  };
  const message = {
    findFirst: vi.fn(async ({ where }: { where: { senderType?: string; createdAt?: { gt: Date } } }) => {
      const found = state.messages.find(
        (m) => (!where.senderType || m['senderType'] === where.senderType) && (!where.createdAt || (m['createdAt'] as Date) > where.createdAt.gt),
      );
      return found ? { id: found['id'] } : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `m${state.messages.length + 1}`, ...data, seq: BigInt(state.messages.length + 1) };
      state.messages.push(row);
      return row;
    }),
  };
  return {
    conversation,
    message,
    aiSetting: { findUnique: vi.fn(async () => ({ ...state.settings })) },
    accountMember: { findFirst: vi.fn(async () => (state.onlineAgents ? { id: 'member' } : null)) },
  } as unknown as Database;
}

const T0 = new Date('2026-09-10T10:00:00Z');

function baseConversation(): FakeState['conversation'] {
  return {
    id: 'c1',
    accountId: 'a1',
    propertyId: 'p1',
    visitorId: 'v1',
    status: 'open',
    priority: 'normal',
    tags: [],
    channel: 'widget',
    assignedMemberId: null,
    aiPausedAt: null,
    aiHandoffAt: null,
    aiFollowupSeq: 0,
    aiIdleNudgedAt: null,
    aiReplyCount: 1,
    lastVisitorMessageAt: new Date(T0.getTime() - 10 * 60_000),
    startedAt: new Date(T0.getTime() - 15 * 60_000),
    deletedAt: null,
    messageSeq: 3n,
    closedAt: null,
    closedByMemberId: null,
  };
}

function baseSettings(): Record<string, unknown> {
  return {
    mode: 'ai',
    assistantName: 'Assistant',
    maxRepliesPerConversation: 50,
    showAiBadge: false,
    handoffWaitMinutes: 3,
    idleNudgeMinutes: 5,
    idleCloseMinutes: 3,
    handoffBackText: 'Nobody from the team is free right now - I am back with you.',
    idleNudgeText: 'Still there? Shall I close this chat?',
    idleCloseText: 'Thanks for chatting. Goodbye!',
  };
}

describe('LifecycleService', () => {
  let state: FakeState;
  let db: Database;
  let events: { publish: ReturnType<typeof vi.fn> };
  let queue: { enqueue: ReturnType<typeof vi.fn> };
  let service: LifecycleService;
  let now: Date;
  const clock: Clock = { now: () => now, timestamp: () => now.getTime() };

  beforeEach(() => {
    now = T0;
    state = { conversation: baseConversation(), settings: baseSettings(), messages: [], onlineAgents: false };
    db = fakeDb(state);
    events = { publish: vi.fn(async () => undefined) };
    queue = { enqueue: vi.fn(async () => undefined) };
    service = new LifecycleService({
      db,
      queue: queue as unknown as QueueProducer,
      events: events as unknown as EventPublisher,
      entitlements: { hasFeature: vi.fn(async () => true) } as unknown as EntitlementService,
      clock,
    });
  });

  it('arms a timer with the next sequence number and a delay in the settings\' minutes', async () => {
    await service.afterAssistantReply(state.conversation, state.settings as never);
    expect(state.conversation.aiFollowupSeq).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      'ai.followup',
      { accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 1 },
      expect.objectContaining({ delay: 5 * 60_000, jobId: 'followup-c1-1', attempts: 1 }),
    );
  });

  it('does nothing on a stale timer, a closed chat, or the team mode', async () => {
    state.conversation.aiFollowupSeq = 4;
    expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 3 })).toEqual({ acted: false, reason: 'stale' });
    state.conversation.status = 'closed';
    expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 4 })).toEqual({ acted: false, reason: 'closed' });
    state.conversation.status = 'open';
    state.settings['mode'] = 'team';
    expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 4 })).toEqual({ acted: false, reason: 'mode_team' });
    expect(state.messages).toHaveLength(0);
  });

  describe('idle visitor', () => {
    it('asks whether to close, then arms the close timer', async () => {
      const result = await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 0 });
      expect(result).toEqual({ acted: true, reason: 'nudged' });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({ senderType: 'bot', body: 'Still there? Shall I close this chat?' });
      expect(state.conversation.aiIdleNudgedAt).toEqual(T0);
      expect(queue.enqueue).toHaveBeenLastCalledWith(
        'ai.followup',
        expect.objectContaining({ kind: 'idle_close', seq: 1 }),
        expect.objectContaining({ delay: 3 * 60_000 }),
      );
    });

    it('does not nudge while the assistant is not the one answering', async () => {
      state.conversation.aiPausedAt = new Date();
      expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 0 })).toEqual({ acted: false, reason: 'paused' });
      state.conversation.aiPausedAt = null;
      state.settings['mode'] = 'ai_when_offline';
      state.onlineAgents = true;
      expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_nudge', seq: 0 })).toEqual({ acted: false, reason: 'agents_online' });
    });

    it('closes with a goodbye after the nudge went unanswered, and tells both sides', async () => {
      state.conversation.aiIdleNudgedAt = new Date(T0.getTime() - 3 * 60_000);
      const result = await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_close', seq: 0 });
      expect(result).toEqual({ acted: true, reason: 'closed' });
      expect(state.conversation.status).toBe('closed');
      expect(state.conversation.closedAt).toEqual(T0);
      expect(state.messages.map((m) => m['senderType'])).toEqual(['bot', 'system']);
      expect(state.messages[0]).toMatchObject({ body: 'Thanks for chatting. Goodbye!' });
      expect(state.messages[1]).toMatchObject({ body: 'Assistant ended this chat after the visitor went quiet.' });
      const types = events.publish.mock.calls.map((call) => (call[0] as { type: string }).type);
      expect(types).toContain('conversation:closed');
    });

    it('does not close on a visitor who answered the nudge', async () => {
      state.conversation.aiIdleNudgedAt = new Date(T0.getTime() - 3 * 60_000);
      state.conversation.lastVisitorMessageAt = new Date(T0.getTime() - 60_000);
      expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'idle_close', seq: 0 })).toEqual({ acted: false, reason: 'visitor_replied' });
      expect(state.conversation.status).toBe('open');
    });
  });

  describe('handoff nobody picked up', () => {
    beforeEach(() => {
      state.conversation.aiHandoffAt = new Date(T0.getTime() - 3 * 60_000);
      state.conversation.assignedMemberId = 'member-1';
      state.conversation.aiPausedAt = state.conversation.aiHandoffAt;
    });

    it('takes the chat back, unassigns it, and offers a ticket', async () => {
      const result = await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'handoff_wait', seq: 0 });
      expect(result).toEqual({ acted: true, reason: 'took_back' });
      expect(state.conversation.assignedMemberId).toBeNull();
      expect(state.conversation.aiPausedAt).toBeNull();
      expect(state.messages[0]).toMatchObject({
        senderType: 'bot',
        body: 'Nobody from the team is free right now - I am back with you.',
        metadata: expect.objectContaining({ kind: 'handoff_back', offer: 'ticket' }),
      });
      const assigned = events.publish.mock.calls.map((call) => call[0] as { type: string; payload: Record<string, unknown> }).find((e) => e.type === 'conversation:assigned');
      expect(assigned?.payload).toMatchObject({ assignedMemberId: null, by: 'ai', reason: 'no_reply' });
      // The visitor may not answer this either: the idle timer is armed.
      expect(queue.enqueue).toHaveBeenLastCalledWith('ai.followup', expect.objectContaining({ kind: 'idle_nudge' }), expect.anything());
    });

    it('leaves the chat with a person who has replied since the handoff', async () => {
      state.messages.push({ id: 'agent-reply', senderType: 'agent', createdAt: new Date(T0.getTime() - 60_000) });
      expect(await service.run({ accountId: 'a1', conversationId: 'c1', kind: 'handoff_wait', seq: 0 })).toEqual({ acted: false, reason: 'person_replied' });
      expect(state.conversation.assignedMemberId).toBe('member-1');
    });
  });

  it('closes a minute after a goodbye', async () => {
    await service.afterGoodbye(state.conversation);
    expect(state.conversation.aiIdleNudgedAt).toEqual(T0);
    expect(queue.enqueue).toHaveBeenCalledWith('ai.followup', expect.objectContaining({ kind: 'idle_close', seq: 1 }), expect.objectContaining({ delay: 60_000 }));
  });
});
