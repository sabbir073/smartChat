import type { RemoteTrack } from '@livekit/rtc-node';
import type { CallDto } from '@smartchat/types';
import { createLogger } from '@smartchat/logger';
import type {
  BotMessageInput,
  CallRow,
  MessageDto,
  VoiceSettings,
  VoiceTurnOutcome,
} from '@smartchat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter.js';
import { int16ToBytes } from './pcm.js';
import { RoomError, type CallRoomEvents, type CallRoomLike } from './room.js';
import { CallSession, type SessionDeps } from './session.js';
import type { AudioSink } from './speaker.js';
import type {
  ListenEvent,
  ListenSocketEvents,
  ListenerLike,
  TtsRequest,
  TtsStream,
} from './speech-client.js';
import type { CallTicketInput } from './tickets.js';

/**
 * The session with every neighbour faked: the room, the speech service, the call service, the
 * brain. The dialogue rules are tested on their own; what is pinned here is the wiring - that
 * a job becomes a greeting in the room and a line in the transcript, that a transcript becomes
 * a brain turn and an answer, that a goodbye ends in `aiFinished`, a left room and a counter
 * back where it was, and that nothing of it leaks past the end.
 */

class FakeRoom implements CallRoomLike {
  readonly events = new Emitter<CallRoomEvents>();
  frames: Int16Array[] = [];
  cleared = 0;
  left = false;
  pumping = 0;
  async connect(): Promise<void> {}
  async publishVoice(): Promise<AudioSink> {
    return {
      push: async (frame) => {
        this.frames.push(frame);
      },
      clear: () => {
        this.cleared += 1;
      },
    };
  }
  async waitForVisitorTrack(): Promise<RemoteTrack> {
    return {} as RemoteTrack;
  }
  pump(
    _track: RemoteTrack,
    _onBytes: (bytes: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.pumping += 1;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  async leave(): Promise<void> {
    this.left = true;
  }
}

class FakeListener implements ListenerLike {
  readonly events = new Emitter<ListenSocketEvents>();
  droppedFrames = 0;
  sent: Uint8Array[] = [];
  languages: string[] = [];
  closed = false;
  send(pcm: Uint8Array): boolean {
    this.sent.push(pcm);
    return true;
  }
  setLanguage(language: 'en' | 'bn'): void {
    this.languages.push(language);
  }
  close(): void {
    this.closed = true;
  }
  hear(event: ListenEvent): void {
    this.events.emit('event', event);
  }
}

const settings: VoiceSettings = {
  id: 'vs-1',
  accountId: 'acc',
  propertyId: 'prop',
  enabled: true,
  ringSeconds: 25,
  aiAnswers: true,
  aiMaxSeconds: 600,
  defaultLanguage: 'en',
  voiceEn: 'en_female',
  voiceBn: 'bn_bd',
  voiceBnSpeaker: 2,
  phrases: { greeting: { en: 'Hi, {business} here, this is {assistant}.' } },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const call = {
  id: 'call-1',
  accountId: 'acc',
  propertyId: 'prop',
  conversationId: 'conv-1',
  visitorId: 'vis-1',
  roomName: 'call-room',
  status: 'connecting',
  handledByAi: true,
  language: null,
} as unknown as CallRow;

interface World {
  deps: SessionDeps;
  room: FakeRoom;
  listener: FakeListener;
  spoken: TtsRequest[];
  posted: BotMessageInput[];
  turns: Array<{ transcript: string; language: string }>;
  finished: string[];
  tickets: CallTicketInput[];
  counter: string[];
  languages: string[];
  callListeners: Array<(call: CallDto) => void>;
  messageListeners: Array<(message: MessageDto) => void>;
  brain: { next: VoiceTurnOutcome };
  humans: { rung: number };
  media: string[];
}

function world(overrides: { visitorEmail?: string | null; grant?: boolean } = {}): World {
  const room = new FakeRoom();
  const listener = new FakeListener();
  const spoken: TtsRequest[] = [];
  const posted: BotMessageInput[] = [];
  const turns: Array<{ transcript: string; language: string }> = [];
  const finished: string[] = [];
  const tickets: CallTicketInput[] = [];
  const counter: string[] = [];
  const languages: string[] = [];
  const callListeners: Array<(call: CallDto) => void> = [];
  const messageListeners: Array<(message: MessageDto) => void> = [];
  const brain = {
    next: {
      kind: 'answer',
      spoken: 'We open at nine.',
      goodbye: false,
      decision: 'answer',
      latencyMs: 10,
      visitorMessageId: 'm1',
    } as VoiceTurnOutcome,
  };
  const humans = { rung: 0 };
  const media: string[] = [];

  const deps: SessionDeps = {
    calls: {
      aiSession: async () =>
        overrides.grant === false
          ? null
          : {
              call,
              join: {
                url: 'wss://public',
                token: 'jwt',
                roomName: 'call-room',
                identity: 'ai:call-1',
              },
              assistantName: 'Mina',
              businessName: 'Acme',
            },
      aiConnected: async () => ({ ...call, status: 'active' }) as CallRow,
      aiLanguage: async (_account, _call, language) => {
        languages.push(language);
      },
      aiFinished: async (_account, _call, reason) => {
        finished.push(reason);
        return null;
      },
      aiRequestHuman: async () => humans.rung,
      onMediaEvent: async (event) => {
        media.push(`${event.event}:${event.participantIdentity ?? ''}`);
      },
    },
    voiceSettings: { forProperty: async () => settings },
    aiReplies: {
      voiceTurn: async (input) => {
        turns.push({ transcript: input.transcript, language: input.language });
        return brain.next;
      },
    },
    visitors: { find: async () => ({ name: 'Ana', email: overrides.visitorEmail ?? null }) },
    transcript: {
      post: async (input) => {
        posted.push(input);
        return { id: `msg-${posted.length}` };
      },
    },
    tickets: {
      create: async (input) => {
        tickets.push(input);
        return { number: 42 };
      },
    },
    bus: {
      onCall: (_id, cb) => {
        callListeners.push(cb);
        return () => undefined;
      },
      onConversationMessage: (_id, cb) => {
        messageListeners.push(cb);
        return () => undefined;
      },
    },
    speech: {
      listen: async () => listener,
      synthesize: async (request: TtsRequest): Promise<TtsStream> => {
        spoken.push(request);
        const bytes = int16ToBytes(new Int16Array(480).fill(100));
        return {
          cache: 'miss',
          sentences: 1,
          sampleRate: 24_000,
          chunks: (async function* () {
            yield bytes;
          })(),
        };
      },
    },
    counter: {
      increment: async () => {
        counter.push('+');
        return counter.length;
      },
      decrement: async () => {
        counter.push('-');
        return 0;
      },
    },
    mediaUrl: 'ws://livekit:7880',
    logger: createLogger({ service: 'test', level: 'silent' }),
    createRoom: () => room,
    looksLikeLookup: (text) => text.split(' ').length >= 4,
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  };
  return {
    deps,
    room,
    listener,
    spoken,
    posted,
    turns,
    finished,
    tickets,
    counter,
    languages,
    callListeners,
    messageListeners,
    brain,
    humans,
    media,
  };
}

const job = { accountId: 'acc', callId: 'call-1', legId: 'leg-1' };

function asks(w: World, text: string, language: 'en' | 'bn' = 'en'): void {
  w.listener.hear({ type: 'speech_start', t: 0 });
  w.listener.hear({ type: 'speech_end', t: 1_000, durationMs: 1_000 });
  w.listener.hear({
    type: 'transcript',
    text,
    language,
    languageConfidence: 1,
    durationMs: 1_000,
    latencyMs: 300,
    model: 'test',
    cut: false,
  });
}

describe('CallSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing for a stale job', async () => {
    const w = world({ grant: false });
    await new CallSession(w.deps, job).run();
    expect(w.counter).toEqual([]);
    expect(w.spoken).toEqual([]);
    expect(w.finished).toEqual([]);
  });

  it('joins, greets in the room and the transcript, answers a question and hangs up after a goodbye', async () => {
    const w = world();
    const session = new CallSession(w.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(10);

    // In the room, counted, listening, and the greeting - the owner's own words - on its way.
    expect(w.counter).toEqual(['+']);
    expect(w.room.pumping).toBe(1);
    expect(w.media).toEqual(['participant_joined:visitor:vis-1']);
    expect(w.spoken.map((request) => request.text)).toEqual(['Hi, Acme here, this is Mina.']);
    expect(w.spoken[0]).toMatchObject({ language: 'en', voice: 'en_female' });
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({
      body: 'Hi, Acme here, this is Mina.',
      assistantName: 'Mina',
      conversation: { id: 'conv-1', accountId: 'acc', propertyId: 'prop', visitorId: 'vis-1' },
      metadata: { voice: true, callId: 'call-1', kind: 'greeting' },
    });
    expect(session.snapshot()).toMatchObject({
      callId: 'call-1',
      mode: 'open',
      speaking: 'greeting',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(w.room.frames.length).toBeGreaterThan(0);
    expect(session.snapshot().speaking).toBeNull();

    // A question: the brain is asked with the transcript, and its answer is spoken, not posted.
    asks(w, 'what are your opening hours');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.turns).toEqual([{ transcript: 'what are your opening hours', language: 'en' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(w.spoken.map((request) => request.text)).toEqual([
      'Hi, Acme here, this is Mina.',
      'We open at nine.',
    ]);
    expect(w.posted).toHaveLength(1);
    expect(session.snapshot().turns).toBe(1);

    // Thanks and goodbye: the goodbye is spoken and posted, then the line is dropped cleanly.
    w.brain.next = { ...w.brain.next, kind: 'chat', spoken: 'You are welcome.', goodbye: true };
    asks(w, 'thanks bye');
    await vi.advanceTimersByTimeAsync(600);
    // Spoken a sentence at a time; written as one line.
    expect(w.spoken.slice(-3).map((request) => request.text)).toEqual([
      'Thank you for calling Acme.',
      'Have a great day.',
      'Goodbye!',
    ]);
    expect(w.posted[w.posted.length - 1]!.body).toBe(
      'Thank you for calling Acme. Have a great day. Goodbye!',
    );
    expect(w.posted[w.posted.length - 1]).toMatchObject({ metadata: { kind: 'goodbye' } });
    await vi.advanceTimersByTimeAsync(2_000);
    await running;
    expect(w.finished).toEqual(['ai_ended']);
    expect(w.room.left).toBe(true);
    expect(w.listener.closed).toBe(true);
    expect(w.counter).toEqual(['+', '-']);
    expect(session.reason).toBe('ai_ended');
  });

  it('switches language with the caller and speaks Bengali with the Bengali voice', async () => {
    const w = world();
    const session = new CallSession(w.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(600);
    w.brain.next = { ...w.brain.next, spoken: 'ঢাকায়।' };
    asks(w, 'আপনাদের অফিস কোথায় অবস্থিত', 'bn');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.languages).toEqual(['bn']);
    expect(w.listener.languages).toEqual(['bn']);
    expect(w.turns[0]).toMatchObject({ language: 'bn' });
    await vi.advanceTimersByTimeAsync(600);
    const answer = w.spoken.find((request) => request.text.includes('ঢাকায়'));
    expect(answer).toMatchObject({ language: 'bn', voice: 'bn_bd', speakerId: 2 });
    void session.shutdown();
    await running;
  });

  it('makes the ticket from an email typed in the chat and reads the number back', async () => {
    const w = world();
    const session = new CallSession(w.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(600);
    w.brain.next = {
      ...w.brain.next,
      kind: 'offer',
      spoken: 'I cannot see orders.',
      decision: 'ticket',
    };
    asks(w, 'can you check order four five six');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.posted[w.posted.length - 1]!.body).toContain('Shall I create a ticket');
    asks(w, 'yes');
    await vi.advanceTimersByTimeAsync(600);
    expect(w.posted[w.posted.length - 1]!.body).toContain('type your email address');

    for (const listener of w.messageListeners) {
      listener({
        conversationId: 'conv-1',
        senderType: 'visitor',
        type: 'text',
        body: 'ana@example.com',
      } as MessageDto);
    }
    await vi.advanceTimersByTimeAsync(600);
    expect(w.tickets).toEqual([
      {
        accountId: 'acc',
        propertyId: 'prop',
        conversationId: 'conv-1',
        visitorId: 'vis-1',
        visitorName: 'Ana',
        email: 'ana@example.com',
        identify: true,
        questions: ['can you check order four five six'],
      },
    ]);
    const confirmation = w.posted[w.posted.length - 1]!;
    expect(confirmation.body).toContain('42');
    expect(confirmation.body).toContain('ana@example.com');
    expect(confirmation.metadata).toMatchObject({ kind: 'ticket' });
    void session.shutdown();
    await running;
  });

  it('ignores its own spoken words coming back on the conversation channel', async () => {
    const w = world();
    const session = new CallSession(w.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(600);
    w.brain.next = { ...w.brain.next, kind: 'offer', spoken: 'No idea.', decision: 'ticket' };
    asks(w, 'can you check order four five six');
    await vi.advanceTimersByTimeAsync(1_000);
    asks(w, 'yes');
    await vi.advanceTimersByTimeAsync(600);
    for (const listener of w.messageListeners) {
      listener({
        conversationId: 'conv-1',
        senderType: 'visitor',
        type: 'text',
        body: 'bot@example.com',
        voice: { callId: 'call-1' },
      } as MessageDto);
      listener({
        conversationId: 'conv-1',
        senderType: 'bot',
        type: 'text',
        body: 'bot@example.com',
      } as MessageDto);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(w.tickets).toEqual([]);
    void session.shutdown();
    await running;
  });

  it('leaves when a person takes the call over', async () => {
    const w = world();
    w.humans.rung = 2;
    const session = new CallSession(w.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(600);
    w.brain.next = {
      ...w.brain.next,
      kind: 'handoff',
      spoken: 'Connecting you.',
      decision: 'human',
    };
    asks(w, 'I want to talk to a person');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.snapshot()).toMatchObject({ mode: 'open' });
    for (const listener of w.callListeners) {
      listener({ id: 'call-1', status: 'connecting', handledByAi: false } as CallDto);
    }
    await vi.advanceTimersByTimeAsync(100);
    await running;
    expect(w.finished).toEqual(['completed']);
    expect(w.room.left).toBe(true);
  });

  it('ends as a failure when the speech socket is lost for good, and on shutdown', async () => {
    const lost = world();
    const session = new CallSession(lost.deps, job);
    const running = session.run();
    await vi.advanceTimersByTimeAsync(10);
    lost.listener.events.emit('failed', new Error('gone'));
    await vi.advanceTimersByTimeAsync(10);
    await running;
    expect(lost.finished).toEqual(['failed']);
    expect(lost.counter).toEqual(['+', '-']);

    const stopped = world();
    const other = new CallSession(stopped.deps, job);
    const run = other.run();
    await vi.advanceTimersByTimeAsync(10);
    await other.shutdown();
    await run;
    expect(stopped.finished).toEqual(['failed']);
    expect(stopped.room.left).toBe(true);
    expect(stopped.counter).toEqual(['+', '-']);
  });

  it('ends cleanly when the visitor leaves before the AI could hear them', async () => {
    const w = world();
    w.room.waitForVisitorTrack = async () => {
      throw new RoomError('visitor_left', 'the visitor left');
    };
    const session = new CallSession(w.deps, job);
    await session.run();
    expect(w.finished).toEqual(['completed']);
    expect(w.spoken).toEqual([]);
    expect(w.counter).toEqual(['+', '-']);
  });
});
