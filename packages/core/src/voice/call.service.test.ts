import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode, Permission, ServerEvent, type TenantContext } from '@smartchat/types';
import type { EntitlementService } from '../billing/entitlements.js';
import { VoiceJob } from '../queue/jobs.js';
import type { QueueProducer } from '../queue/producer.js';
import type {
  DomainEvent,
  EventPublisher,
  MessageDto,
  SystemMessageEvent,
} from '../realtime/events.js';
import type { RedisClient } from '../redis/client.js';
import type { VisitorIdentity } from '../services/conversation.service.js';
import type { Clock } from '../time.js';
import { CallService, TRANSFER_RING_SECONDS } from './call.service.js';
import type { CallLegRow, CallRow, CallStore, MemberSummary } from './call.store.js';
import { identity as who, type MediaRooms } from './media.js';
import type { VoiceSettings, VoiceSettingsService } from './settings.service.js';

/**
 * The call state machine, against an in-memory store.
 *
 * What is pinned here is what goes wrong on a real desk: two people answering at once, a
 * transfer nobody picks up, the visitor hanging up mid-ring, the AI taking over only when it may,
 * and the one who handed a call over actually leaving the room. The media server and the queue
 * are recorded, not real - the end-to-end run has the real ones.
 */

const ACCOUNT = 'acc-1';
const PROPERTY = 'prop-1';
const VISITOR = 'vis-1';

class MemoryStore implements CallStore {
  calls = new Map<string, CallRow>();
  legRows: CallLegRow[] = [];
  events: Array<{ callId: string; type: string; data?: Record<string, unknown> }> = [];
  messages: Array<{ body: string; event: SystemMessageEvent }> = [];
  online: MemberSummary[] = [];
  assistantConfigured = true;
  private seq = 0;

  async createCall(data: {
    accountId: string;
    propertyId: string;
    conversationId: string;
    visitorId: string;
    roomName: string;
    language: string | null;
    now: Date;
  }): Promise<CallRow> {
    const row: CallRow = {
      id: `call-${++this.seq}`,
      accountId: data.accountId,
      propertyId: data.propertyId,
      conversationId: data.conversationId,
      visitorId: data.visitorId,
      status: 'ringing',
      roomName: data.roomName,
      answeredByMemberId: null,
      handledByAi: false,
      pendingKind: null,
      pendingMemberId: null,
      ringSeq: 0,
      language: data.language,
      startedAt: data.now,
      answeredAt: null,
      endedAt: null,
      endReason: null,
      durationSeconds: 0,
      aiSeconds: 0,
      createdAt: data.now,
      updatedAt: data.now,
    };
    this.calls.set(row.id, row);
    return { ...row };
  }
  async getCall(accountId: string, callId: string): Promise<CallRow | null> {
    const row = this.calls.get(callId);
    return row && row.accountId === accountId ? { ...row } : null;
  }
  async getCallByRoom(roomName: string): Promise<CallRow | null> {
    const row = [...this.calls.values()].find((candidate) => candidate.roomName === roomName);
    return row ? { ...row } : null;
  }
  async liveCallForVisitor(accountId: string, visitorId: string): Promise<CallRow | null> {
    const row = [...this.calls.values()].find(
      (c) => c.accountId === accountId && c.visitorId === visitorId && c.status !== 'ended',
    );
    return row ? { ...row } : null;
  }
  async updateCall(callId: string, data: Partial<CallRow>): Promise<CallRow> {
    const row = this.calls.get(callId)!;
    Object.assign(row, data, { updatedAt: new Date() });
    return { ...row };
  }
  async listCalls(
    accountId: string,
    filter: { propertyIds?: string[]; status?: CallRow['status']; limit: number },
  ): Promise<CallRow[]> {
    return [...this.calls.values()]
      .filter(
        (c) =>
          c.accountId === accountId &&
          (!filter.status || c.status === filter.status) &&
          (!filter.propertyIds || filter.propertyIds.includes(c.propertyId)),
      )
      .slice(0, filter.limit)
      .map((c) => ({ ...c }));
  }
  async staleCalls(): Promise<CallRow[]> {
    return [];
  }
  async createLeg(data: {
    accountId: string;
    callId: string;
    kind: CallLegRow['kind'];
    memberId: string | null;
    identity: string;
    now: Date;
    joined?: boolean;
  }): Promise<CallLegRow> {
    const leg: CallLegRow = {
      id: `leg-${this.legRows.length + 1}`,
      accountId: data.accountId,
      callId: data.callId,
      kind: data.kind,
      memberId: data.memberId,
      identity: data.identity,
      joinedAt: data.joined ? data.now : null,
      leftAt: null,
      createdAt: data.now,
    };
    this.legRows.push(leg);
    return { ...leg };
  }
  async updateLeg(
    legId: string,
    data: Partial<Pick<CallLegRow, 'joinedAt' | 'leftAt'>>,
  ): Promise<CallLegRow> {
    const leg = this.legRows.find((candidate) => candidate.id === legId)!;
    Object.assign(leg, data);
    return { ...leg };
  }
  async legs(callId: string): Promise<CallLegRow[]> {
    return this.legRows.filter((leg) => leg.callId === callId).map((leg) => ({ ...leg }));
  }
  async addEvent(data: {
    accountId: string;
    callId: string;
    type: string;
    data?: Record<string, unknown>;
    now: Date;
  }): Promise<never> {
    this.events.push({
      callId: data.callId,
      type: data.type,
      ...(data.data ? { data: data.data } : {}),
    });
    return undefined as never;
  }
  async onlineMembers(): Promise<MemberSummary[]> {
    return this.online;
  }
  async member(_accountId: string, memberId: string): Promise<MemberSummary | null> {
    return { id: memberId, name: `Name of ${memberId}` };
  }
  async visitor(): Promise<{ name: string | null; email: string | null }> {
    return { name: 'Rahim', email: 'rahim@example.com' };
  }
  async property(): Promise<{ name: string }> {
    return { name: 'Acme' };
  }
  async assistant(): Promise<{ name: string; configured: boolean }> {
    return { name: 'Mira', configured: this.assistantConfigured };
  }
  async insertSystemMessage(input: {
    body: string;
    event: SystemMessageEvent;
    now: Date;
  }): Promise<MessageDto> {
    this.messages.push({ body: input.body, event: input.event });
    return {
      id: `m-${this.messages.length}`,
      conversationId: 'conv-1',
      seq: this.messages.length,
      clientMessageId: null,
      senderType: 'system',
      senderId: null,
      senderName: null,
      type: 'system',
      body: input.body,
      createdAt: input.now.toISOString(),
      readAt: null,
      event: input.event,
    };
  }
}

function store(): MemoryStore {
  return new MemoryStore();
}

function fakeMedia() {
  const removed: Array<{ room: string; identity: string }> = [];
  const deleted: string[] = [];
  const present = new Map<string, Set<string>>();
  const media: MediaRooms = {
    createRoom: vi.fn(async ({ name }: { name: string }) => {
      present.set(name, new Set());
    }),
    grant: vi.fn(async ({ roomName, identity }: { roomName: string; identity: string }) => ({
      url: 'wss://lk.test',
      token: `token-for-${identity}`,
      roomName,
      identity,
    })),
    removeParticipant: vi.fn(async (roomName: string, identity: string) => {
      removed.push({ room: roomName, identity });
      present.get(roomName)?.delete(identity);
    }),
    deleteRoom: vi.fn(async (roomName: string) => {
      deleted.push(roomName);
    }),
    participants: vi.fn(async (roomName: string) => [...(present.get(roomName) ?? [])]),
    readWebhook: vi.fn(async () => ({
      event: '',
      roomName: null,
      participantIdentity: null,
      id: '',
    })),
  };
  return { media, removed, deleted };
}

function fakeRedis() {
  const keys = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    client: {
      set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
        if (keys.has(key)) return null;
        keys.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => keys.get(key) ?? null),
      sadd: vi.fn(async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
        return 1;
      }),
      scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
      expire: vi.fn(async () => 1),
    } as unknown as RedisClient,
    keys,
  };
}

function fakeQueue() {
  const jobs: Array<{ job: string; payload: Record<string, unknown>; delay?: number }> = [];
  const queue = {
    enqueue: vi.fn(
      async (job: string, payload: Record<string, unknown>, options?: { delay?: number }) => {
        jobs.push({
          job,
          payload,
          ...(options?.delay !== undefined ? { delay: options.delay } : {}),
        });
      },
    ),
  } as unknown as QueueProducer;
  return { queue, jobs };
}

function fakeEvents() {
  const published: DomainEvent[] = [];
  const events: EventPublisher = {
    publish: vi.fn(async (event: DomainEvent) => void published.push(event)),
  };
  return { events, published };
}

function fakeSettings(overrides: Partial<VoiceSettings> = {}) {
  const row: VoiceSettings = {
    id: 'vs-1',
    accountId: ACCOUNT,
    propertyId: PROPERTY,
    enabled: true,
    ringSeconds: 25,
    aiAnswers: true,
    aiMaxSeconds: 600,
    defaultLanguage: 'en',
    voiceEn: 'en_female',
    voiceBn: 'bn_bd',
    voiceBnSpeaker: 0,
    phrases: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  return { forProperty: vi.fn(async () => row) } as unknown as VoiceSettingsService;
}

function fakeEntitlements(
  options: { voice?: boolean; aiAgent?: boolean; minutesAllowed?: boolean } = {},
) {
  return {
    assertFeature: vi.fn(async (_accountId: string, feature: string) => {
      if (feature === 'voice' && options.voice === false)
        throw new AppError(ErrorCode.FEATURE_NOT_IN_PLAN, 'no voice');
    }),
    hasFeature: vi.fn(async (_accountId: string, feature: string) =>
      feature === 'aiAgent' ? options.aiAgent !== false : options.voice !== false,
    ),
    voiceMinutesAllowance: vi.fn(async () => ({
      allowed: options.minutesAllowed !== false,
      used: 0,
      limit: 500,
    })),
  } as unknown as EntitlementService;
}

const visitor: VisitorIdentity = {
  accountId: ACCOUNT,
  propertyId: PROPERTY,
  visitorId: VISITOR,
  sessionId: 'sess-1',
  visitorName: 'Rahim',
};

function member(
  memberId: string,
  permissions: Permission[] = [
    Permission.CONVERSATION_VIEW_ASSIGNED,
    Permission.CONVERSATION_REPLY,
  ],
): TenantContext {
  return {
    accountId: ACCOUNT,
    userId: `user-${memberId}`,
    memberId,
    actorName: `Name of ${memberId}`,
    actorType: 'user',
    permissions: new Set(permissions),
    requestId: 'req',
  } as unknown as TenantContext;
}

function tickingClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    timestamp: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface World {
  service: CallService;
  store: MemoryStore;
  media: ReturnType<typeof fakeMedia>;
  queue: ReturnType<typeof fakeQueue>;
  events: ReturnType<typeof fakeEvents>;
  clock: ReturnType<typeof tickingClock>;
  redis: ReturnType<typeof fakeRedis>;
}

function world(
  options: {
    settings?: Partial<VoiceSettings>;
    entitlements?: Parameters<typeof fakeEntitlements>[0];
    aiMaxCalls?: number;
    online?: MemberSummary[];
    aiBusy?: number;
  } = {},
): World {
  const memory = store();
  memory.online = options.online ?? [
    { id: 'm1', name: 'Sabbir' },
    { id: 'm2', name: 'Nayeem' },
  ];
  const media = fakeMedia();
  const queue = fakeQueue();
  const events = fakeEvents();
  const clock = tickingClock();
  const redis = fakeRedis();
  if (options.aiBusy !== undefined) redis.keys.set('voice:ai_calls', String(options.aiBusy));
  const service = new CallService({
    store: memory,
    media: media.media,
    settings: fakeSettings(options.settings),
    entitlements: fakeEntitlements(options.entitlements),
    events: events.events,
    queue: queue.queue,
    redis: redis.client,
    conversations: {
      ensureForVisitor: vi.fn(async () => ({ conversation: { id: 'conv-1' }, isNew: true })),
    },
    aiMaxCalls: options.aiMaxCalls ?? 1,
    clock,
  });
  return { service, store: memory, media, queue, events, clock, redis };
}

function callEvents(w: World, type: string): DomainEvent[] {
  return w.events.published.filter((event) => event.type === type);
}

describe('starting a call', () => {
  it('rings everyone who is available, keys the visitor into the room and arms the ring timer', async () => {
    const w = world();
    const { call, join } = await w.service.start(visitor, {});

    expect(call.status).toBe('ringing');
    expect(call.visitor).toEqual({ name: 'Rahim', email: 'rahim@example.com' });
    expect(join?.identity).toBe(who.visitor(VISITOR));
    expect(w.media.media.createRoom).toHaveBeenCalledOnce();
    expect(w.store.events.map((event) => event.type)).toEqual(['started', 'ring']);
    expect(w.store.events[1]?.data).toEqual({ targets: ['m1', 'm2'] });
    expect(w.queue.jobs).toEqual([
      {
        job: VoiceJob.RING_TIMEOUT,
        payload: { accountId: ACCOUNT, callId: call.id, ringSeq: 0 },
        delay: 25_000,
      },
    ]);
    // The inbox and the visitor both hear it ring.
    const updates = callEvents(w, ServerEvent.CALL_UPDATED);
    expect(updates.some((event) => event.agentsOnly)).toBe(true);
    expect(updates.some((event) => event.toVisitor)).toBe(true);
    expect(w.store.messages[0]?.event.kind).toBe('call.started');
  });

  it('refuses when the website has calling off, the plan lacks it, or the minutes are gone', async () => {
    await expect(
      world({ settings: { enabled: false } }).service.start(visitor, {}),
    ).rejects.toMatchObject({ code: ErrorCode.FEATURE_NOT_AVAILABLE });
    await expect(
      world({ entitlements: { voice: false } }).service.start(visitor, {}),
    ).rejects.toMatchObject({ code: ErrorCode.FEATURE_NOT_IN_PLAN });
    await expect(
      world({ entitlements: { minutesAllowed: false } }).service.start(visitor, {}),
    ).rejects.toMatchObject({ code: ErrorCode.PLAN_LIMIT_REACHED });
  });

  it('is one call however many times the button is pressed', async () => {
    const w = world();
    const first = await w.service.start(visitor, {});
    const second = await w.service.start(visitor, {});
    expect(second.call.id).toBe(first.call.id);
    expect(w.store.calls.size).toBe(1);
    expect(w.queue.jobs).toHaveLength(1);
  });

  it('goes straight to the AI when nobody on the team is available', async () => {
    const w = world({ online: [] });
    const { call } = await w.service.start(visitor, {});
    expect(call.status).toBe('connecting');
    expect(call.handledByAi).toBe(true);
    expect(call.answeredByName).toBe('Mira');
    expect(w.queue.jobs.map((job) => job.job)).toEqual([VoiceJob.AI_JOIN]);
    expect(w.store.messages.map((m) => m.event.kind)).toEqual(['call.started', 'call.answered']);
  });

  it('is missed on the spot when nobody is available and the AI may not answer', async () => {
    const w = world({ online: [], settings: { aiAnswers: false } });
    const { call, join } = await w.service.start(visitor, {});
    expect(call.status).toBe('ended');
    expect(call.endReason).toBe('no_answer');
    expect(join).toBeNull();
    expect(w.store.messages.at(-1)?.event.kind).toBe('call.missed');
    expect(w.media.deleted).toHaveLength(1);
  });

  it('does not hand a call to an AI that is already on as many calls as it may take', async () => {
    const w = world({ online: [], aiMaxCalls: 1, aiBusy: 1 });
    const { call } = await w.service.start(visitor, {});
    expect(call.status).toBe('ended');
    expect(call.endReason).toBe('no_answer');
  });
});

describe('answering', () => {
  it('lets the first person in, tells the second it was taken, and keys only the winner into the room', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});

    const won = await w.service.answer(member('m1'), call.id);
    expect(won.call.status).toBe('connecting');
    expect(won.call.answeredByMemberId).toBe('m1');
    expect(won.call.answeredByName).toBe('Name of m1');
    expect(won.join.identity).toBe(who.member('m1'));

    await expect(w.service.answer(member('m2'), call.id)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(w.store.messages.at(-1)?.event).toMatchObject({
      kind: 'call.answered',
      by: 'agent',
      actorName: 'Name of m1',
    });
  });

  it('wins the race on the claim, not on who read the row first', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    const results = await Promise.allSettled([
      w.service.answer(member('m1'), call.id),
      w.service.answer(member('m2'), call.id),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(w.store.calls.get(call.id)?.answeredByMemberId).toBe(
      (winners[0] as PromiseFulfilledResult<{ call: { answeredByMemberId: string } }>).value.call
        .answeredByMemberId,
    );
  });

  it('becomes live once both the visitor and the answerer are in the room, from either report', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.answer(member('m1'), call.id);
    await w.service.onMediaEvent({
      event: 'participant_joined',
      roomName: w.store.calls.get(call.id)!.roomName,
      participantIdentity: who.visitor(VISITOR),
    });
    expect(w.store.calls.get(call.id)?.status).toBe('connecting');
    await w.service.joined(member('m1'), call.id);
    expect(w.store.calls.get(call.id)?.status).toBe('active');
  });

  it('makes a ring timer that fires after an answer do nothing', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.answer(member('m1'), call.id);
    await w.service.ringTimeout(ACCOUNT, call.id, 0);
    expect(w.store.calls.get(call.id)?.status).toBe('connecting');
    expect(w.queue.jobs.map((job) => job.job)).not.toContain(VoiceJob.AI_JOIN);
  });

  it('requires the reply permission and a membership', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await expect(
      w.service.answer(member('m1', [Permission.CONVERSATION_VIEW_ASSIGNED]), call.id),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });
});

describe('when nobody answers', () => {
  it('the AI picks up when the ring timer fires', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.ringTimeout(ACCOUNT, call.id, 0);
    const row = w.store.calls.get(call.id)!;
    expect(row.status).toBe('connecting');
    expect(row.handledByAi).toBe(true);
    expect(row.answeredAt).not.toBeNull();
    expect(w.queue.jobs.at(-1)).toMatchObject({
      job: VoiceJob.AI_JOIN,
      payload: { callId: call.id },
    });
    expect(w.store.events.map((event) => event.type)).toContain('no_answer');
  });

  it('is missed when the AI is switched off for the website', async () => {
    const w = world({ settings: { aiAnswers: false } });
    const { call } = await w.service.start(visitor, {});
    await w.service.ringTimeout(ACCOUNT, call.id, 0);
    expect(w.store.calls.get(call.id)).toMatchObject({
      status: 'ended',
      endReason: 'no_answer',
      durationSeconds: 0,
    });
  });

  it('is missed when the plan has no AI agent', async () => {
    const w = world({ entitlements: { aiAgent: false } });
    const { call } = await w.service.start(visitor, {});
    await w.service.ringTimeout(ACCOUNT, call.id, 0);
    expect(w.store.calls.get(call.id)?.endReason).toBe('no_answer');
  });

  it('goes to the AI as soon as everyone who was rung has declined', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.decline(member('m1'), call.id);
    expect(w.store.calls.get(call.id)?.status).toBe('ringing');
    await w.service.decline(member('m2'), call.id);
    expect(w.store.calls.get(call.id)?.handledByAi).toBe(true);
  });
});

describe('hanging up', () => {
  it('a visitor who gives up while it rings cancels it, and the team stops ringing', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    const ended = await w.service.hangUp(visitor, call.id);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'cancelled', durationSeconds: 0 });
    expect(callEvents(w, ServerEvent.CALL_UPDATED).at(-1)?.payload).toMatchObject({
      call: { status: 'ended' },
    });
    await expect(w.service.answer(member('m1'), call.id)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('counts the minutes from the answer, and the AI seconds from the AI leg', async () => {
    const w = world({ online: [] });
    const { call } = await w.service.start(visitor, {});
    await w.service.onMediaEvent({
      event: 'participant_joined',
      roomName: w.store.calls.get(call.id)!.roomName,
      participantIdentity: who.visitor(VISITOR),
    });
    await w.service.aiConnected(ACCOUNT, call.id);
    expect(w.store.calls.get(call.id)?.status).toBe('active');
    w.clock.advance(95_000);
    const ended = await w.service.aiFinished(ACCOUNT, call.id, 'ai_ended');
    expect(ended?.durationSeconds).toBe(95);
    expect(ended?.aiSeconds).toBe(95);
    expect(w.store.messages.at(-1)?.event).toMatchObject({
      kind: 'call.ended',
      by: 'ai',
      durationSeconds: 95,
    });
  });

  it('ends when the visitor drops off the media server', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.answer(member('m1'), call.id);
    const roomName = w.store.calls.get(call.id)!.roomName;
    await w.service.onMediaEvent({
      event: 'participant_left',
      roomName,
      participantIdentity: who.visitor(VISITOR),
    });
    expect(w.store.calls.get(call.id)).toMatchObject({
      status: 'ended',
      endReason: 'visitor_left',
    });
  });

  it('only the person on the call can end it from the team side', async () => {
    const w = world();
    const { call } = await w.service.start(visitor, {});
    await w.service.answer(member('m1'), call.id);
    await expect(w.service.endByMember(member('m2'), call.id)).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
    const ended = await w.service.endByMember(member('m1'), call.id);
    expect(ended.endReason).toBe('completed');
    expect(w.media.deleted).toEqual([w.store.calls.get(call.id)!.roomName]);
  });
});

describe('transfers', () => {
  async function liveWith(w: World, memberId: string) {
    const { call } = await w.service.start(visitor, {});
    await w.service.answer(member(memberId), call.id);
    const roomName = w.store.calls.get(call.id)!.roomName;
    await w.service.onMediaEvent({
      event: 'participant_joined',
      roomName,
      participantIdentity: who.visitor(VISITOR),
    });
    await w.service.onMediaEvent({
      event: 'participant_joined',
      roomName,
      participantIdentity: who.member(memberId),
    });
    expect(w.store.calls.get(call.id)?.status).toBe('active');
    return call.id;
  }

  it('rings only the colleague it was sent to, and the sender keeps the call until they answer', async () => {
    const w = world();
    const callId = await liveWith(w, 'm1');
    const transferring = await w.service.transfer(member('m1'), callId, {
      to: 'member',
      memberId: 'm2',
    });
    expect(transferring.status).toBe('ringing');
    expect(transferring.pending).toEqual({ kind: 'member', memberId: 'm2', name: 'Name of m2' });
    expect(transferring.answeredByMemberId).toBe('m1');
    expect(w.queue.jobs.at(-1)).toMatchObject({
      job: VoiceJob.TRANSFER_TIMEOUT,
      delay: TRANSFER_RING_SECONDS * 1000,
    });

    // Somebody else cannot grab it in passing.
    w.store.online.push({ id: 'm3', name: 'Third' });
    await expect(w.service.answer(member('m3'), callId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });

    const accepted = await w.service.answer(member('m2'), callId);
    expect(accepted.call.answeredByMemberId).toBe('m2');
    expect(accepted.call.pending).toBeNull();
    // The one who handed over is out of the room; the visitor never was.
    expect(w.media.removed).toEqual([
      { room: w.store.calls.get(callId)!.roomName, identity: who.member('m1') },
    ]);
    expect(w.store.messages.at(-1)?.event).toMatchObject({
      kind: 'call.transferred',
      targetName: 'Name of m2',
    });
  });

  it('comes back to the sender when the target does not answer in time', async () => {
    const w = world();
    const callId = await liveWith(w, 'm1');
    await w.service.transfer(member('m1'), callId, { to: 'member', memberId: 'm2' });
    const seq = w.store.calls.get(callId)!.ringSeq;
    await w.service.transferTimeout(ACCOUNT, callId, seq);
    const row = w.store.calls.get(callId)!;
    expect(row.status).toBe('active');
    expect(row.pendingKind).toBeNull();
    expect(row.answeredByMemberId).toBe('m1');
    expect(w.store.events.at(-1)).toMatchObject({
      type: 'transfer_failed',
      data: { why: 'no_answer' },
    });
    // A late answer by the target is refused: the call is live again, not ringing.
    await expect(w.service.answer(member('m2'), callId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('comes back when the target declines', async () => {
    const w = world();
    const callId = await liveWith(w, 'm1');
    await w.service.transfer(member('m1'), callId, { to: 'member', memberId: 'm2' });
    await w.service.decline(member('m2'), callId);
    expect(w.store.calls.get(callId)).toMatchObject({
      status: 'active',
      pendingKind: null,
      answeredByMemberId: 'm1',
    });
  });

  it('refuses a transfer to yourself, to someone offline, or by someone not on the call', async () => {
    const w = world();
    const callId = await liveWith(w, 'm1');
    await expect(
      w.service.transfer(member('m1'), callId, { to: 'member', memberId: 'm1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    await expect(
      w.service.transfer(member('m1'), callId, { to: 'member', memberId: 'offline' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await expect(
      w.service.transfer(member('m2'), callId, { to: 'member', memberId: 'm1' }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it('to the AI: the AI joins first, then the person leaves, and the visitor is never alone', async () => {
    const w = world();
    const callId = await liveWith(w, 'm1');
    const transferring = await w.service.transfer(member('m1'), callId, { to: 'ai' });
    expect(transferring.status).toBe('connecting');
    expect(transferring.handledByAi).toBe(true);
    expect(transferring.pending).toEqual({ kind: 'ai' });
    expect(w.media.removed).toEqual([]);
    expect(w.queue.jobs.at(-1)).toMatchObject({ job: VoiceJob.AI_JOIN });

    await w.service.aiConnected(ACCOUNT, callId);
    const row = w.store.calls.get(callId)!;
    expect(row.status).toBe('active');
    expect(row.pendingKind).toBeNull();
    expect(w.media.removed).toEqual([{ room: row.roomName, identity: who.member('m1') }]);
    expect(w.store.messages.at(-1)?.event).toMatchObject({
      kind: 'call.transferred',
      targetName: 'Mira',
    });
    // The person leaving the room afterwards is expected, not the end of the call.
    await w.service.onMediaEvent({
      event: 'participant_left',
      roomName: row.roomName,
      participantIdentity: who.member('m1'),
    });
    expect(w.store.calls.get(callId)?.status).toBe('active');
  });

  it('to the AI is refused when the AI is off for the website or has no room', async () => {
    const off = world({ settings: { aiAnswers: false } });
    const offId = await liveWith(off, 'm1');
    await expect(off.service.transfer(member('m1'), offId, { to: 'ai' })).rejects.toMatchObject({
      code: ErrorCode.FEATURE_NOT_AVAILABLE,
    });

    const busy = world({ aiMaxCalls: 1, aiBusy: 1 });
    const busyId = await liveWith(busy, 'm1');
    await expect(busy.service.transfer(member('m1'), busyId, { to: 'ai' })).rejects.toMatchObject({
      code: ErrorCode.TEMPORARILY_UNAVAILABLE,
    });
  });
});

describe('the AI asking for a person', () => {
  async function aiLive(w: World) {
    const { call } = await w.service.start(visitor, {});
    await w.service.ringTimeout(ACCOUNT, call.id, 0);
    const roomName = w.store.calls.get(call.id)!.roomName;
    await w.service.onMediaEvent({
      event: 'participant_joined',
      roomName,
      participantIdentity: who.visitor(VISITOR),
    });
    await w.service.aiConnected(ACCOUNT, call.id);
    expect(w.store.calls.get(call.id)?.status).toBe('active');
    return call.id;
  }

  it('rings the team while the AI stays, hands over when someone answers, and removes the AI', async () => {
    const w = world();
    const callId = await aiLive(w);
    const rung = await w.service.aiRequestHuman(ACCOUNT, callId);
    expect(rung).toBe(2);
    expect(w.store.calls.get(callId)).toMatchObject({ status: 'ringing', handledByAi: true });

    const taken = await w.service.answer(member('m2'), callId);
    expect(taken.call).toMatchObject({
      handledByAi: false,
      answeredByMemberId: 'm2',
      status: 'connecting',
    });
    expect(w.media.removed).toEqual([
      { room: w.store.calls.get(callId)!.roomName, identity: who.ai(callId) },
    ]);
    expect(w.store.messages.at(-1)?.event).toMatchObject({
      kind: 'call.transferred',
      by: 'ai',
      targetName: 'Name of m2',
    });
  });

  it('goes back to the AI when nobody answers, without ending the call', async () => {
    const w = world();
    const callId = await aiLive(w);
    await w.service.aiRequestHuman(ACCOUNT, callId);
    const seq = w.store.calls.get(callId)!.ringSeq;
    await w.service.ringTimeout(ACCOUNT, callId, seq);
    expect(w.store.calls.get(callId)).toMatchObject({ status: 'active', handledByAi: true });
    expect(w.store.events.at(-1)?.type).toBe('transfer_failed');
  });

  it('says nobody is there when the team is offline', async () => {
    const w = world({ online: [] });
    const callId = await aiLive(w);
    expect(await w.service.aiRequestHuman(ACCOUNT, callId)).toBe(0);
    expect(w.store.calls.get(callId)?.status).toBe('active');
  });
});

describe('listing', () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await w.service.start(visitor, {});
  });

  it('shows the ringing call to anyone who may see conversations on that website', async () => {
    const calls = await w.service.list(member('m1'), { limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('ringing');
  });

  it('hides a website the member is restricted away from', async () => {
    const restricted = { ...member('m1'), propertyIds: new Set(['other-prop']) } as TenantContext;
    expect(await w.service.list(restricted, { limit: 10 })).toEqual([]);
    const call = [...w.store.calls.values()][0]!;
    await expect(w.service.get(restricted, call.id)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
