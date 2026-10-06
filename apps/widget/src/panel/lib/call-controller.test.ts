import { describe, expect, it } from 'vitest';
import type { CallDto } from '@smartchat/types';
import { CallController, type CallApi } from './call-controller.js';
import type { CallRoom, CallRoomHandlers } from './call-room.js';
import { BAR_LINGER_MS } from './call-state.js';
import type { Ringback } from './ringback.js';

/**
 * The controller with every edge faked: the API answers from a script, the room is a record of
 * what was asked of it, the ringback counts starts and stops, and the timers fire when told.
 */

function dto(overrides: Partial<CallDto> = {}): CallDto {
  return {
    id: 'call-1',
    propertyId: 'prop',
    conversationId: 'conv-1',
    visitorId: 'vis',
    status: 'ringing',
    answeredByMemberId: null,
    answeredByName: null,
    handledByAi: false,
    pending: null,
    queuedAt: null,
    visitor: { name: null, email: null },
    language: null,
    startedAt: '2026-10-05T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    endReason: null,
    durationSeconds: 0,
    ...overrides,
  };
}

const grant = { url: 'wss://lk.example', token: 'jwt' };

/** Let every pending promise chain in the controller run to its end. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeRoom implements CallRoom {
  log: string[] = [];
  connected = false;
  failConnect = false;
  failMicrophone = false;
  constructor(public handlers: CallRoomHandlers) {}
  async connect(url: string, token: string) {
    this.log.push(`connect ${url} ${token}`);
    if (this.failConnect) throw new Error('refused');
    this.connected = true;
  }
  async setMicrophoneEnabled(enabled: boolean) {
    this.log.push(`mic ${enabled}`);
    if (this.failMicrophone) throw new Error('NotAllowedError');
  }
  async startAudio() {
    this.log.push('startAudio');
  }
  async disconnect() {
    this.log.push('disconnect');
    this.connected = false;
  }
}

class FakeRingback implements Ringback {
  primed = 0;
  started = 0;
  stopped = 0;
  prime() {
    this.primed += 1;
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeTimers {
  private queue: Array<{ id: number; at: number; handler: () => void }> = [];
  private next = 1;
  now = 0;
  setTimeout = (handler: () => void, ms: number): number => {
    const id = this.next++;
    this.queue.push({ id, at: this.now + ms, handler });
    return id;
  };
  clearTimeout = (id: number): void => {
    this.queue = this.queue.filter((entry) => entry.id !== id);
  };
  /** Fire whatever is due by then, in order. */
  advance(ms: number): void {
    this.now += ms;
    const due = this.queue.filter((entry) => entry.at <= this.now).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((entry) => entry.at > this.now);
    for (const entry of due) entry.handler();
  }
  get pending(): number {
    return this.queue.length;
  }
}

function harness(script: Partial<CallApi> & { microphone?: boolean; roomFails?: boolean } = {}) {
  const calls: string[] = [];
  const rooms: FakeRoom[] = [];
  const ringback = new FakeRingback();
  const timers = new FakeTimers();
  const api: CallApi = {
    start: async (input) => {
      calls.push(`start ${JSON.stringify(input)}`);
      return script.start ? script.start(input) : { call: dto(), join: grant };
    },
    current: async () => {
      calls.push('current');
      return script.current ? script.current() : null;
    },
    get: async (id) => {
      calls.push(`get ${id}`);
      return script.get ? script.get(id) : dto({ id });
    },
    joined: async (id) => {
      calls.push(`joined ${id}`);
      return script.joined ? script.joined(id) : dto({ id, status: 'connecting' });
    },
    end: async (id) => {
      calls.push(`end ${id}`);
      return script.end ? script.end(id) : dto({ id, status: 'ended', endReason: 'cancelled' });
    },
  };
  const controller = new CallController({
    api,
    ringback,
    timers,
    now: () => Date.parse('2026-10-05T10:01:00.000Z'),
    requestMicrophone: async () => script.microphone ?? true,
    createRoom: async (handlers) => {
      if (script.roomFails) throw new Error('chunk failed to load');
      const room = new FakeRoom(handlers);
      rooms.push(room);
      return room;
    },
    language: 'bn',
  });
  const changes: string[] = [];
  controller.subscribe(() => changes.push(controller.getSnapshot().phase.kind));
  return { controller, api, calls, rooms, ringback, timers, changes };
}

describe('CallController: starting a call', () => {
  it('primes the ringback in the tap, settles the microphone, loads the room, then rings', async () => {
    const h = harness();
    await h.controller.startCall({ name: 'Ada' });

    expect(h.ringback.primed).toBe(1);
    expect(h.calls).toEqual(['start {"preChat":{"name":"Ada"},"language":"bn"}', 'joined call-1']);
    expect(h.rooms).toHaveLength(1);
    expect(h.rooms[0]!.log).toEqual(['connect wss://lk.example jwt', 'mic true', 'startAudio']);
    expect(h.controller.phase).toMatchObject({
      kind: 'live',
      call: { status: 'ringing' },
      room: 'joined',
      muted: false,
    });
    expect(h.ringback.started).toBe(1);
    expect(h.ringback.stopped).toBe(0);
  });

  it('does not ring the team when the microphone is refused', async () => {
    const h = harness({ microphone: false });
    await h.controller.startCall();
    expect(h.calls).toEqual([]);
    expect(h.rooms).toEqual([]);
    expect(h.controller.phase).toEqual({
      kind: 'over',
      call: null,
      text: 'Microphone access is needed to call',
    });
    expect(h.ringback.started).toBe(0);
  });

  it('does not ring the team when the media client cannot be loaded', async () => {
    const h = harness({ roomFails: true });
    await h.controller.startCall();
    expect(h.calls).toEqual([]);
    expect(h.controller.phase).toEqual({
      kind: 'over',
      call: null,
      text: 'We could not start the call. Please try again.',
    });
  });

  it("shows the server's refusal in the bar and goes back to idle after six seconds", async () => {
    const h = harness({
      start: async () => {
        throw Object.assign(new Error('used up'), { code: 'PLAN_LIMIT_REACHED', status: 402 });
      },
    });
    await h.controller.startCall();
    expect(h.controller.phase).toEqual({ kind: 'over', call: null, text: 'Call minutes used up' });
    expect(h.rooms[0]!.log).toEqual(['disconnect']);

    h.timers.advance(BAR_LINGER_MS - 1);
    expect(h.controller.phase.kind).toBe('over');
    h.timers.advance(1);
    expect(h.controller.phase.kind).toBe('idle');
    expect(h.changes).toEqual(['starting', 'over', 'idle']);
  });

  it('shows a call missed on the spot without opening a room', async () => {
    const h = harness({
      start: async () => ({ call: dto({ status: 'ended', endReason: 'no_answer' }), join: null }),
    });
    await h.controller.startCall();
    expect(h.controller.phase).toMatchObject({
      kind: 'over',
      text: 'Nobody is available right now — leave a message below',
    });
    expect(h.rooms[0]!.log).toEqual(['disconnect']);
    expect(h.ringback.started).toBe(0);
    expect(h.timers.pending).toBe(1);
  });

  it('ignores a second press while a call is on', async () => {
    const h = harness();
    await h.controller.startCall();
    await h.controller.startCall();
    expect(h.calls.filter((entry) => entry.startsWith('start'))).toHaveLength(1);
  });
});

describe('CallController: the call as the server tells it', () => {
  it('stops the ringback the moment somebody answers, and tears down when the call ends', async () => {
    const h = harness();
    await h.controller.startCall();
    expect(h.ringback.started).toBe(1);

    h.controller.onServerUpdate(
      dto({
        status: 'connecting',
        answeredByName: 'Sabbir',
        answeredAt: '2026-10-05T10:00:10.000Z',
      }),
    );
    expect(h.ringback.stopped).toBe(1);
    expect(h.controller.phase).toMatchObject({
      kind: 'live',
      call: { status: 'connecting' },
      room: 'joined',
    });

    h.controller.onServerUpdate(
      dto({ status: 'active', answeredByName: 'Sabbir', answeredAt: '2026-10-05T10:00:10.000Z' }),
    );
    h.controller.onServerUpdate(
      dto({
        status: 'ended',
        endReason: 'agent_left',
        answeredAt: '2026-10-05T10:00:10.000Z',
        durationSeconds: 62,
      }),
    );
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Call ended · 1:02' });
    expect(h.rooms[0]!.log.at(-1)).toBe('disconnect');
    expect(h.ringback.stopped).toBe(1);

    h.timers.advance(BAR_LINGER_MS);
    expect(h.controller.phase.kind).toBe('idle');
  });

  it('keeps a stale "joined" answer from winding the bar back, but takes an ended one', async () => {
    const h = harness({ joined: async () => dto({ status: 'ended', endReason: 'cancelled' }) });
    await h.controller.startCall();
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Call cancelled' });
  });

  it('leaves a live call it never started alone', () => {
    const h = harness();
    h.controller.onServerUpdate(dto({ status: 'active' }));
    expect(h.controller.phase.kind).toBe('idle');
    expect(h.calls).toEqual([]);
  });
});

describe('CallController: hanging up and muting', () => {
  it('hangs up through the server and shows its answer', async () => {
    const h = harness({ end: async () => dto({ status: 'ended', endReason: 'cancelled' }) });
    await h.controller.startCall();
    const hangUp = h.controller.hangUp();
    expect(h.controller.getSnapshot().hangingUp).toBe(true);
    await hangUp;
    expect(h.controller.getSnapshot().hangingUp).toBe(false);
    expect(h.calls.at(-1)).toBe('end call-1');
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Call cancelled' });
    expect(h.rooms[0]!.log.at(-1)).toBe('disconnect');
    expect(h.ringback.stopped).toBe(1);
  });

  it('ends the call on its own when the server cannot be told', async () => {
    const h = harness({
      end: async () => {
        throw new Error('offline');
      },
    });
    await h.controller.startCall();
    h.controller.onServerUpdate(
      dto({ status: 'active', answeredByName: 'Sabbir', answeredAt: '2026-10-05T10:00:10.000Z' }),
    );
    await h.controller.hangUp();
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Call ended · 0:50' });
    expect(h.rooms[0]!.log.at(-1)).toBe('disconnect');
  });

  it('mutes by unpublishing the microphone and remembers it', async () => {
    const h = harness();
    await h.controller.startCall();
    await h.controller.setMuted(true);
    expect(h.rooms[0]!.log.at(-1)).toBe('mic false');
    expect(h.controller.phase).toMatchObject({ muted: true });
    await h.controller.setMuted(false);
    expect(h.rooms[0]!.log.at(-1)).toBe('mic true');
    expect(h.controller.phase).toMatchObject({ muted: false });
  });
});

describe('CallController: losing the room', () => {
  it('ends the call and says "Connection lost" when the network drops', async () => {
    const h = harness({
      end: async () =>
        dto({
          status: 'ended',
          endReason: 'visitor_left',
          answeredAt: '2026-10-05T10:00:10.000Z',
          durationSeconds: 20,
        }),
    });
    await h.controller.startCall();
    h.controller.onServerUpdate(
      dto({ status: 'active', answeredByName: 'Sabbir', answeredAt: '2026-10-05T10:00:10.000Z' }),
    );

    h.rooms[0]!.handlers.onDisconnected('network');
    expect(h.controller.phase).toMatchObject({
      kind: 'live',
      room: 'lost',
      lostText: 'Connection lost',
    });
    await flush();
    expect(h.calls.at(-1)).toBe('end call-1');
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Connection lost' });
  });

  it('asks the server when the media server closed the room, and shows a normal end', async () => {
    const h = harness({
      get: async () =>
        dto({
          status: 'ended',
          endReason: 'completed',
          answeredAt: '2026-10-05T10:00:10.000Z',
          durationSeconds: 95,
        }),
    });
    await h.controller.startCall();
    h.controller.onServerUpdate(
      dto({ status: 'active', answeredByName: 'Sabbir', answeredAt: '2026-10-05T10:00:10.000Z' }),
    );

    h.rooms[0]!.handlers.onDisconnected('closed');
    await flush();
    expect(h.calls.at(-1)).toBe('get call-1');
    expect(h.controller.phase).toMatchObject({ kind: 'over', text: 'Call ended · 1:35' });
  });

  it('bows out without ending the call when another tab took it', async () => {
    const h = harness();
    await h.controller.startCall();
    h.rooms[0]!.handlers.onDisconnected('elsewhere');
    await flush();
    expect(h.calls.some((entry) => entry.startsWith('end'))).toBe(false);
    expect(h.controller.phase).toMatchObject({
      kind: 'over',
      text: 'This call continues in another tab',
    });
  });

  it('ends the call honestly when the room cannot be joined', async () => {
    const h = harness({ end: async () => dto({ status: 'ended', endReason: 'cancelled' }) });
    const original = h.controller['deps'].createRoom;
    h.controller['deps'].createRoom = async (handlers) => {
      const room = (await original(handlers)) as FakeRoom;
      room.failConnect = true;
      return room;
    };
    await h.controller.startCall();
    await flush();
    expect(h.calls).toContain('end call-1');
    expect(h.controller.phase).toMatchObject({
      kind: 'over',
      text: 'The call could not be connected',
    });
  });
});

describe('CallController: resuming after a reload', () => {
  it('rejoins the live call the server reports', async () => {
    const h = harness({
      current: async () => ({
        call: dto({
          status: 'active',
          answeredByName: 'Sabbir',
          answeredAt: '2026-10-05T10:00:10.000Z',
        }),
        join: grant,
      }),
    });
    await h.controller.resume();
    expect(h.calls).toEqual(['current', 'joined call-1']);
    expect(h.rooms[0]!.log).toEqual(['connect wss://lk.example jwt', 'mic true', 'startAudio']);
    expect(h.controller.phase).toMatchObject({
      kind: 'live',
      call: { status: 'active' },
      room: 'joined',
    });
    expect(h.ringback.started).toBe(0);
  });

  it('does nothing when there is no call to resume, or one that has ended', async () => {
    const none = harness({ current: async () => null });
    await none.controller.resume();
    expect(none.controller.phase.kind).toBe('idle');
    expect(none.rooms).toEqual([]);

    const ended = harness({
      current: async () => ({
        call: dto({ status: 'ended', endReason: 'completed' }),
        join: grant,
      }),
    });
    await ended.controller.resume();
    expect(ended.controller.phase.kind).toBe('idle');
    expect(ended.rooms).toEqual([]);
  });

  it('rings again when the resumed call is still ringing', async () => {
    const h = harness({ current: async () => ({ call: dto(), join: grant }) });
    await h.controller.resume();
    expect(h.ringback.started).toBe(1);
  });

  it('is left alone when a call is already on screen', async () => {
    const h = harness({ current: async () => ({ call: dto({ id: 'other' }), join: grant }) });
    await h.controller.startCall();
    await h.controller.resume();
    expect(h.calls).not.toContain('current');
  });
});

describe('CallController: dispose', () => {
  it('silences, leaves the room and clears the bar', async () => {
    const h = harness();
    await h.controller.startCall();
    h.controller.dispose();
    expect(h.ringback.stopped).toBeGreaterThan(0);
    expect(h.rooms[0]!.log.at(-1)).toBe('disconnect');
    expect(h.controller.phase).toEqual({ kind: 'idle' });
  });
});
