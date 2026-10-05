import type { RemoteTrack } from '@livekit/rtc-node';
import {
  identity,
  phrase as resolvePhrase,
  looksLikeLookup as coreLooksLikeLookup,
  type AiReplyService,
  type BotMessageInput,
  type CallService,
  type VoiceAiJoinPayload,
  type VoiceSettings,
  type VoiceSettingsService,
} from '@smartchat/core';
import type { Logger } from '@smartchat/logger';
import type { VoiceLanguage } from '@smartchat/types';
import type { AiCallCounter } from './counter.js';
import {
  Dialogue,
  FIXED_LINES,
  type DialogueAction,
  type DialogueEvent,
  type FinishReason,
  type Line,
  type TimerName,
  type Utterance,
} from './dialogue.js';
import type { CallEventBus } from './events.js';
import { CallRoom, RoomError, type CallRoomLike, type CallRoomOptions } from './room.js';
import { Speaker, monotonicNow, type SpeakResult, type Synthesizer } from './speaker.js';
import type { ListenEvent, ListenOptions, ListenerLike } from './speech-client.js';
import type { CallTicketInput } from './tickets.js';

/**
 * One AI call, from the queue job to the hang-up.
 *
 * The session is the hands and ears around the dialogue machine. It joins the room, feeds the
 * visitor's audio to the speech service, hands every event the machine wants to see to it with
 * the clock reading, and carries out the actions that come back: speaking through the speaker,
 * asking the brain, ringing the team, writing the ticket, running the timers. The machine
 * decides; this file only does, and reports back what happened. Whatever goes wrong - the
 * visitor never arriving, the speech service dying, a bug - ends in `aiFinished` and a clean
 * room, never in a crash of the process or a call left open.
 */

/** The speech service as the session uses it: ears to open, a mouth to ask for sound. */
export interface SpeechLike extends Synthesizer {
  listen(options: ListenOptions): Promise<ListenerLike>;
}

/**
 * Everything a session reaches outside itself, as narrow as it can be stated. The real things
 * are the call service, the brain, the database and the media room; a test hands in fakes and
 * the session cannot tell the difference, which is how the wiring here gets tested at all.
 */
export interface SessionDeps {
  calls: Pick<
    CallService,
    'aiSession' | 'aiConnected' | 'aiLanguage' | 'aiFinished' | 'aiRequestHuman' | 'onMediaEvent'
  >;
  voiceSettings: Pick<VoiceSettingsService, 'forProperty'>;
  aiReplies: Pick<AiReplyService, 'voiceTurn'>;
  visitors: {
    find(
      accountId: string,
      visitorId: string,
    ): Promise<{ name: string | null; email: string | null } | null>;
  };
  /** Writes a line the assistant said on its own into the conversation. */
  transcript: { post(input: BotMessageInput): Promise<unknown> };
  tickets: { create(input: CallTicketInput): Promise<{ number: number } | null> };
  bus: Pick<CallEventBus, 'onCall' | 'onConversationMessage'>;
  speech: SpeechLike;
  counter: Pick<AiCallCounter, 'increment' | 'decrement'>;
  /** The media server as this process reaches it: ws(s)://livekit:7880. */
  mediaUrl: string;
  logger: Logger;
  createRoom?: (options: CallRoomOptions) => CallRoomLike;
  looksLikeLookup?: (text: string) => boolean;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SessionSnapshot {
  callId: string;
  accountId: string;
  conversationId: string | null;
  startedAt: string;
  seconds: number;
  language: VoiceLanguage | null;
  mode: string;
  speaking: string | null;
  thinking: boolean;
  turns: number;
}

/** How long the visitor's microphone is waited for after the AI is in the room. */
const VISITOR_TRACK_TIMEOUT_MS = 20_000;
/** Speaking that fails this many times in a row means the mouth is gone: the call ends. */
const MAX_TTS_FAILURES = 3;

interface CallContext {
  accountId: string;
  propertyId: string;
  conversationId: string;
  visitorId: string;
  visitorName: string | null;
  assistantName: string;
  businessName: string;
  settings: VoiceSettings;
}

interface TurnStats {
  turnId: number;
  transcriptChars: number;
  sttMs: number | null;
  language: VoiceLanguage;
  startedAt: number;
  brainMs: number | null;
  kind: string | null;
  decision: string | null;
}

export class CallSession {
  readonly callId: string;
  readonly accountId: string;
  private readonly legId: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly startedAt = new Date();
  private readonly startedTick: number;
  private context: CallContext | null = null;
  private roomName = '';
  private dialogue: Dialogue | null = null;
  private speaker: Speaker | null = null;
  private listen: ListenerLike | null = null;
  private room: CallRoomLike | null = null;
  private readonly timers = new Map<TimerName, NodeJS.Timeout>();
  private readonly unsubscribe: Array<() => void> = [];
  private pump: AbortController | null = null;
  private finished = false;
  private finishReason: FinishReason | null = null;
  private readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;
  private ttsFailures = 0;
  private turns = 0;
  private lastStt: { latencyMs: number; chars: number } | null = null;
  private readonly turnStats = new Map<number, TurnStats>();
  /** The brain turn whose answer is being spoken, for the one log line per turn. */
  private spokenTurn: TurnStats | null = null;

  constructor(
    private readonly deps: SessionDeps,
    job: VoiceAiJoinPayload,
  ) {
    this.callId = job.callId;
    this.accountId = job.accountId;
    this.legId = job.legId;
    this.now = deps.now ?? monotonicNow;
    this.startedTick = this.now();
    this.log = deps.logger.child({ callId: job.callId, accountId: job.accountId });
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  snapshot(): SessionSnapshot {
    const state = this.dialogue?.snapshot();
    return {
      callId: this.callId,
      accountId: this.accountId,
      conversationId: this.context?.conversationId ?? null,
      startedAt: this.startedAt.toISOString(),
      seconds: Math.round((this.now() - this.startedTick) / 1000),
      language: state?.language ?? null,
      mode: state?.mode ?? 'joining',
      speaking: state?.speaking ?? null,
      thinking: state?.thinking ?? false,
      turns: this.turns,
    };
  }

  /** Take the call. Resolves when the session is over, however it ended. Never throws after the room was joined. */
  async run(): Promise<void> {
    const grant = await this.deps.calls.aiSession(this.accountId, this.callId, this.legId);
    if (!grant) {
      this.log.info({ legId: this.legId }, 'ai join job is stale - the call moved on');
      return;
    }
    const { call } = grant;
    this.roomName = call.roomName;
    const [settings, visitor] = await Promise.all([
      this.deps.voiceSettings.forProperty(call.accountId, call.propertyId),
      this.deps.visitors.find(call.accountId, call.visitorId),
    ]);
    this.context = {
      accountId: call.accountId,
      propertyId: call.propertyId,
      conversationId: call.conversationId,
      visitorId: call.visitorId,
      visitorName: visitor?.name ?? null,
      assistantName: grant.assistantName,
      businessName: grant.businessName,
      settings,
    };
    const language: VoiceLanguage =
      call.language === 'bn' || call.language === 'en' ? call.language : settings.defaultLanguage;

    const count = await this.deps.counter.increment();
    this.log.info(
      {
        conversationId: call.conversationId,
        language,
        aiCalls: count,
        aiMaxSeconds: settings.aiMaxSeconds,
      },
      'ai call session starting',
    );
    try {
      await this.converse(grant.join.token, language, visitor?.email ?? null);
    } catch (error) {
      this.log.error({ err: error }, 'ai call session failed');
      await this.end('failed');
    } finally {
      await this.deps.counter.decrement().catch((error: unknown) => {
        this.log.error({ err: error }, 'failed to decrement the ai call counter');
      });
    }
  }

  /** The process is going down: leave quietly and let the call service record it. */
  async shutdown(): Promise<void> {
    await this.end('failed');
  }

  // ---------------------------------------------------------------------------

  private async converse(
    token: string,
    language: VoiceLanguage,
    visitorEmail: string | null,
  ): Promise<void> {
    if (this.finished) return;
    const context = this.context!;
    const roomOptions: CallRoomOptions = {
      url: this.deps.mediaUrl,
      token,
      log: (event, detail) => this.log.warn(detail, event),
    };
    const room = this.deps.createRoom
      ? this.deps.createRoom(roomOptions)
      : new CallRoom(roomOptions);
    this.room = room;
    room.events.on('visitor_left', () => this.feed({ type: 'visitor_left' }));
    room.events.on('disconnected', ({ reason }) => {
      if (!this.finished) this.log.info({ reason }, 'disconnected from the room');
      this.feed({ type: 'disconnected' });
    });

    await room.connect();
    const sink = await room.publishVoice();
    let visitorTrack: RemoteTrack;
    try {
      visitorTrack = await room.waitForVisitorTrack(VISITOR_TRACK_TIMEOUT_MS);
    } catch (error) {
      // No visitor to talk to is not a failure of the AI when they hung up first.
      if (error instanceof RoomError && error.code !== 'timeout') {
        this.log.info({ reason: error.code }, error.message);
        await this.end('completed');
        return;
      }
      throw error;
    }
    // The visitor's audio is first-hand proof they are in the room. The media server's webhook
    // says the same, but a webhook can be late or lost, and a call that never leaves
    // `connecting` cannot be handed to a person and is swept away as failed. Telling the call
    // service what the AI can hear costs nothing when the webhook already did.
    await this.deps.calls.onMediaEvent({
      event: 'participant_joined',
      roomName: this.roomName,
      participantIdentity: identity.visitor(context.visitorId),
    });
    const connected = await this.deps.calls.aiConnected(this.accountId, this.callId);
    if (!connected || connected.status === 'ended') {
      this.log.info('the call ended while the AI was joining');
      await this.end('completed');
      return;
    }

    const listen = await this.deps.speech.listen({ sticky: language, callId: this.callId });
    this.listen = listen;
    listen.events.on('event', (event) => this.onListen(event));
    listen.events.on('reconnected', ({ attempt }) =>
      this.log.warn({ attempt, dropped: listen.droppedFrames }, 'speech socket reconnected'),
    );
    listen.events.on('failed', (error) => {
      this.log.error({ err: error }, 'speech socket lost for good');
      void this.end('failed');
    });

    this.speaker = new Speaker({
      tts: this.deps.speech,
      sink,
      now: this.now,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.dialogue = new Dialogue({
      language,
      visitorEmail,
      aiMaxSeconds: context.settings.aiMaxSeconds,
      looksLikeLookup: this.deps.looksLikeLookup ?? coreLooksLikeLookup,
    });

    this.unsubscribe.push(
      this.deps.bus.onCall(this.callId, (call) =>
        this.feed({ type: 'call_updated', status: call.status, handledByAi: call.handledByAi }),
      ),
      this.deps.bus.onConversationMessage(context.conversationId, (message) => {
        // Only what the visitor typed: their spoken words come back on this channel too, marked.
        if (message.senderType !== 'visitor' || message.type !== 'text' || message.voice) return;
        this.feed({ type: 'chat_message', text: message.body });
      }),
    );

    // The ears: the visitor's microphone into the speech service, and again should their
    // browser re-publish it after a reconnect.
    this.startPump(visitorTrack);
    room.events.on('visitor_track', (track) => this.startPump(track));
    if (this.finished) return;
    this.feed({ type: 'start' });
    await this.done;
  }

  private startPump(track: RemoteTrack): void {
    if (this.finished || !this.room) return;
    this.pump?.abort();
    const controller = new AbortController();
    this.pump = controller;
    this.room
      .pump(track, (bytes) => this.listen?.send(bytes), controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          this.log.warn({ err: error }, 'visitor audio stream ended with an error');
      });
  }

  private onListen(event: ListenEvent): void {
    switch (event.type) {
      case 'speech_start':
      case 'speech_cancel':
      case 'speech_end':
        this.feed({ type: event.type });
        return;
      case 'transcript':
        this.lastStt = { latencyMs: event.latencyMs, chars: event.text.length };
        this.log.debug(
          {
            text: event.text,
            language: event.language,
            confidence: event.languageConfidence,
            sttMs: event.latencyMs,
            model: event.model,
          },
          'heard',
        );
        this.feed({ type: 'transcript', text: event.text, language: event.language });
        return;
      case 'error':
        // A failed recognition is an utterance that produced nothing: the machine is told so,
        // or the silence it stopped measuring at speech_start would never be measured again.
        this.log.warn({ message: event.message }, 'speech service reported an error');
        this.feed({
          type: 'transcript',
          text: '',
          language: this.dialogue?.snapshot().language ?? 'en',
        });
        return;
      default:
        return;
    }
  }

  /** One event into the machine, its actions out and done. The only way state changes. */
  private feed(event: DialogueEvent): void {
    if (this.finished || !this.dialogue) return;
    let actions: DialogueAction[];
    try {
      actions = this.dialogue.handle(event, this.now());
    } catch (error) {
      this.log.error({ err: error, event: event.type }, 'dialogue failed on an event');
      void this.end('failed');
      return;
    }
    for (const action of actions) this.execute(action);
  }

  private execute(action: DialogueAction): void {
    switch (action.type) {
      case 'set_timer': {
        const existing = this.timers.get(action.name);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.timers.delete(action.name);
          this.feed({ type: 'timer', name: action.name });
        }, action.ms);
        this.timers.set(action.name, timer);
        return;
      }
      case 'clear_timer': {
        const existing = this.timers.get(action.name);
        if (existing) clearTimeout(existing);
        this.timers.delete(action.name);
        return;
      }
      case 'speak':
        this.speak(action.utterance);
        return;
      case 'stop_speaking':
        this.speaker?.stop();
        return;
      case 'brain':
        this.think(action.turnId, action.transcript, action.language);
        return;
      case 'request_human':
        this.requestHuman();
        return;
      case 'create_ticket':
        this.createTicket(action.email, action.identify, action.questions);
        return;
      case 'set_language':
        this.setLanguage(action.language);
        return;
      case 'finish':
        void this.end(action.reason);
        return;
      default:
        return;
    }
  }

  // --- actions ---------------------------------------------------------------

  private speak(utterance: Utterance): void {
    const speaker = this.speaker;
    const context = this.context;
    if (!speaker || !context) return;
    const lines = utterance.parts.map((part) => ({
      text: this.resolve(part.line, utterance.language),
      post: part.post,
    }));
    const text = lines
      .map((line) => line.text)
      .filter(Boolean)
      .join(' ');
    for (const line of lines) if (line.post && line.text) this.post(line.text, utterance.kind);

    const voice =
      utterance.language === 'bn'
        ? { voice: context.settings.voiceBn, speakerId: context.settings.voiceBnSpeaker }
        : { voice: context.settings.voiceEn };
    if (
      utterance.kind === 'answer' ||
      utterance.kind === 'ticket' ||
      utterance.kind === 'handoff'
    ) {
      this.spokenTurn = this.latestTurn();
    }
    speaker
      .speak({ text, language: utterance.language, ...voice })
      .then((result) => {
        this.ttsFailures = 0;
        this.log.debug(
          {
            kind: utterance.kind,
            sentences: result.sentences,
            firstAudioMs: result.firstAudioMs,
            durationMs: result.durationMs,
            completed: result.completed,
            cacheHits: result.cacheHits,
          },
          'spoke',
        );
        this.logTurn(utterance, result);
        this.feed({ type: 'speech_done', id: utterance.id, completed: result.completed });
      })
      .catch((error: unknown) => {
        this.ttsFailures += 1;
        this.log.error(
          { err: error, kind: utterance.kind, failures: this.ttsFailures },
          'speaking failed',
        );
        if (this.ttsFailures >= MAX_TTS_FAILURES) {
          void this.end('failed');
          return;
        }
        this.feed({ type: 'speech_done', id: utterance.id, completed: false });
      });
  }

  private resolve(line: Line, language: VoiceLanguage): string {
    const context = this.context!;
    if ('text' in line) return line.text.trim();
    if ('fixed' in line) return FIXED_LINES[line.fixed][language];
    return resolvePhrase(context.settings.phrases, line.phrase, language, {
      assistant: context.assistantName,
      business: context.businessName,
      ...(line.number !== undefined ? { number: line.number } : {}),
      ...(line.email !== undefined ? { email: line.email } : {}),
    });
  }

  /** What the assistant said on its own, written to the conversation so the inbox shows the call. */
  private post(body: string, kind: Utterance['kind']): void {
    const context = this.context!;
    this.deps.transcript
      .post({
        conversation: {
          id: context.conversationId,
          accountId: context.accountId,
          propertyId: context.propertyId,
          visitorId: context.visitorId,
        },
        assistantName: context.assistantName,
        body,
        metadata: { voice: true, callId: this.callId, kind },
        now: new Date(),
      })
      .catch((error: unknown) =>
        this.log.warn({ err: error, kind }, 'failed to write a spoken line to the transcript'),
      );
  }

  private think(turnId: number, transcript: string, language: VoiceLanguage): void {
    const context = this.context!;
    const started = this.now();
    this.turns += 1;
    const stats: TurnStats = {
      turnId,
      transcriptChars: transcript.length,
      sttMs: this.lastStt?.latencyMs ?? null,
      language,
      startedAt: started,
      brainMs: null,
      kind: null,
      decision: null,
    };
    this.turnStats.set(turnId, stats);
    this.deps.aiReplies
      .voiceTurn({
        accountId: context.accountId,
        propertyId: context.propertyId,
        conversationId: context.conversationId,
        callId: this.callId,
        transcript,
        language,
      })
      .then((outcome) => {
        stats.brainMs = this.now() - started;
        stats.kind = outcome.kind;
        stats.decision = outcome.decision;
        this.feed({
          type: 'brain_result',
          turnId,
          outcome: { kind: outcome.kind, spoken: outcome.spoken, goodbye: outcome.goodbye },
        });
      })
      .catch((error: unknown) => {
        stats.brainMs = this.now() - started;
        stats.kind = 'failed';
        this.log.error({ err: error, turn: turnId }, 'the brain failed on a spoken turn');
        this.feed({ type: 'brain_failed', turnId });
      });
  }

  private latestTurn(): TurnStats | null {
    let latest: TurnStats | null = null;
    for (const stats of this.turnStats.values()) {
      if (stats.brainMs !== null && (!latest || stats.turnId > latest.turnId)) latest = stats;
    }
    return latest;
  }

  /** One line per turn: how long the caller waited for the words, the answer, and the voice. */
  private logTurn(utterance: Utterance, result: SpeakResult): void {
    const stats = this.spokenTurn;
    if (
      !stats ||
      (utterance.kind !== 'answer' && utterance.kind !== 'ticket' && utterance.kind !== 'handoff')
    )
      return;
    this.spokenTurn = null;
    this.turnStats.delete(stats.turnId);
    this.log.info(
      {
        turn: stats.turnId,
        language: stats.language,
        chars: stats.transcriptChars,
        sttMs: stats.sttMs,
        brainMs: stats.brainMs,
        ttsFirstChunkMs: result.firstAudioMs,
        spokenMs: result.durationMs,
        kind: stats.kind,
        decision: stats.decision,
        completed: result.completed,
      },
      'voice turn',
    );
  }

  private requestHuman(): void {
    this.deps.calls
      .aiRequestHuman(this.accountId, this.callId)
      .then((rung) => {
        this.log.info(
          { rung },
          rung > 0 ? 'ringing the team for the caller' : 'nobody available to take the call',
        );
        this.feed({ type: 'human_requested', rung });
      })
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'failed to ring the team');
        this.feed({ type: 'human_requested', rung: 0 });
      });
  }

  private createTicket(email: string, identify: boolean, questions: string[]): void {
    const context = this.context!;
    this.deps.tickets
      .create({
        accountId: context.accountId,
        propertyId: context.propertyId,
        conversationId: context.conversationId,
        visitorId: context.visitorId,
        visitorName: context.visitorName,
        email,
        identify,
        questions,
      })
      .then((ticket) => {
        if (!ticket) {
          this.log.warn('no ticket was created for the call');
          this.feed({ type: 'ticket_failed' });
          return;
        }
        this.log.info({ ticket: ticket.number }, 'ticket created from the call');
        this.feed({ type: 'ticket_created', number: ticket.number, email });
      })
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'failed to create a ticket from the call');
        this.feed({ type: 'ticket_failed' });
      });
  }

  private setLanguage(language: VoiceLanguage): void {
    this.log.info({ language }, 'the caller switched language');
    this.listen?.setLanguage(language);
    this.deps.calls
      .aiLanguage(this.accountId, this.callId, language)
      .catch((error: unknown) =>
        this.log.warn({ err: error }, 'failed to record the call language'),
      );
  }

  // --- the end ---------------------------------------------------------------

  private async end(reason: FinishReason): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.finishReason = reason;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const off of this.unsubscribe.splice(0)) off();
    this.speaker?.stop();
    this.pump?.abort();

    try {
      await this.deps.calls.aiFinished(this.accountId, this.callId, reason);
    } catch (error) {
      this.log.error({ err: error, reason }, 'failed to record the end of the ai call');
    }
    this.listen?.close();
    if (this.room) await this.room.leave();
    this.log.info(
      {
        reason,
        seconds: Math.round((this.now() - this.startedTick) / 1000),
        turns: this.turns,
        droppedFrames: this.listen?.droppedFrames ?? 0,
      },
      'ai call session ended',
    );
    this.resolveDone();
  }

  get reason(): FinishReason | null {
    return this.finishReason;
  }
}
