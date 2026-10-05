import type { CallStatus, VoiceLanguage, VoicePhraseKey } from '@smartchat/types';
import { classifyYesNo, extractEmail, isCancel, isFiller } from './classify.js';

/**
 * The rules of a call, with nothing else in the room.
 *
 * Everything the AI decides on a call is decided here: when to greet, when to think, when to
 * say "hold on", what to do with a caller who talks over it, how a ticket is agreed and made,
 * when to give up on the silence. The machine takes one event at a time with the clock reading,
 * changes its own state and hands back the actions that follow - speak this, ask the brain
 * that, set that timer, hang up. It never waits for anything itself. Timers are actions too: it
 * asks for one by name and is told when it fires. That is what makes every rule in this file
 * testable in milliseconds with a fake clock, and what keeps the media, the speech service and
 * the database out of the one place where the behaviour has to be right.
 *
 * The session (`session.ts`) executes the actions and feeds back what happened.
 */

export type Language = VoiceLanguage;

export type UtteranceKind =
  | 'greeting'
  | 'holdOn'
  | 'stillChecking'
  | 'answer'
  | 'ticket'
  | 'handoff'
  | 'stillThere'
  | 'goodbye'
  | 'maxLength';

/** The two lines an owner cannot override: they exist for failures the settings page does not mention. */
export type FixedLineKey = 'noEmail' | 'ticketFailed';

export const FIXED_LINES: Record<FixedLineKey, Record<Language, string>> = {
  noEmail: {
    en: 'I did not receive an email address, so no ticket was created. Is there anything else I can help with?',
    bn: 'আমি কোনো ইমেইল ঠিকানা পাইনি, তাই কোনো টিকিট তৈরি হয়নি। আর কিছু কি সাহায্য করতে পারি?',
  },
  ticketFailed: {
    en: 'I am sorry, I could not create the ticket right now. You can also write to us in the chat. Is there anything else I can help with?',
    bn: 'দুঃখিত, এই মুহূর্তে আমি টিকিটটি তৈরি করতে পারলাম না। আপনি চ্যাটেও আমাদের লিখতে পারেন। আর কিছু কি সাহায্য করতে পারি?',
  },
};

export type Line =
  | { phrase: VoicePhraseKey; number?: string | number; email?: string }
  | { text: string }
  | { fixed: FixedLineKey };

export interface Part {
  line: Line;
  /** Whether this line is written to the conversation as something the assistant said. */
  post: boolean;
}

export interface Utterance {
  id: number;
  kind: UtteranceKind;
  language: Language;
  parts: Part[];
  /** Whether the caller may cut it off by talking. The time-limit line is not. */
  interruptible: boolean;
  /** What follows once it has been said in full. */
  after: 'none' | 'goodbye' | 'request_human';
  startedAt: number;
}

/** What the brain came back with, in the terms the machine needs. */
export interface BrainOutcome {
  kind: 'answer' | 'chat' | 'offer' | 'handoff' | 'unavailable';
  spoken: string;
  goodbye: boolean;
}

export type TimerName = 'holdOn' | 'bargeIn' | 'silence' | 'emailWait' | 'maxLength' | 'hangup';

export type FinishReason = 'ai_ended' | 'failed' | 'completed';

export type DialogueEvent =
  | { type: 'start' }
  | { type: 'speech_start' }
  | { type: 'speech_cancel' }
  | { type: 'speech_end' }
  | { type: 'transcript'; text: string; language: Language }
  /** A message the visitor typed in the chat box, not something said on the call. */
  | { type: 'chat_message'; text: string }
  | { type: 'speech_done'; id: number; completed: boolean }
  | { type: 'brain_result'; turnId: number; outcome: BrainOutcome }
  | { type: 'brain_failed'; turnId: number }
  | { type: 'human_requested'; rung: number }
  | { type: 'call_updated'; status: CallStatus; handledByAi: boolean }
  | { type: 'ticket_created'; number: string | number; email: string }
  | { type: 'ticket_failed' }
  | { type: 'timer'; name: TimerName }
  | { type: 'visitor_left' }
  | { type: 'disconnected' };

export type DialogueAction =
  | { type: 'speak'; utterance: Utterance }
  | { type: 'stop_speaking' }
  | { type: 'brain'; turnId: number; transcript: string; language: Language }
  | { type: 'request_human' }
  | { type: 'create_ticket'; email: string; identify: boolean; questions: string[] }
  | { type: 'set_language'; language: Language }
  | { type: 'set_timer'; name: TimerName; ms: number }
  | { type: 'clear_timer'; name: TimerName }
  | { type: 'finish'; reason: FinishReason };

export interface DialogueTiming {
  /** After the caller stopped talking: when "hold on" is due if the brain has not answered. */
  holdOnMs: number;
  /**
   * How long the caller must keep talking before the voice is cut. The service reports a start
   * before it knows the sound lasted its minimum; a cough is cancelled within this window.
   */
  bargeInConfirmMs: number;
  /** The opening of the greeting that a caller's "hello?" is not allowed to cut. */
  greetingGuardMs: number;
  /** Silence after the assistant spoke before it asks whether anyone is there. */
  silenceMs: number;
  /** Silence after that question before it says goodbye. */
  silenceAfterNudgeMs: number;
  /** How long an email is waited for in the chat box. */
  emailWaitMs: number;
  /** After the goodbye has been heard, before the line is dropped. */
  hangupGraceMs: number;
  /** Questions kept while the brain is busy; older ones are forgotten. */
  maxQueued: number;
}

export const DEFAULT_TIMING: DialogueTiming = {
  holdOnMs: 1_800,
  bargeInConfirmMs: 300,
  greetingGuardMs: 1_500,
  silenceMs: 15_000,
  silenceAfterNudgeMs: 20_000,
  emailWaitMs: 120_000,
  hangupGraceMs: 800,
  maxQueued: 2,
};

export interface DialogueOptions {
  language: Language;
  /** The address the visitor is already known by, when there is one; a ticket needs no asking then. */
  visitorEmail: string | null;
  aiMaxSeconds: number;
  /** Whether a transcript reads as something to look up (long, or a question). From the core. */
  looksLikeLookup: (text: string) => boolean;
  timing?: Partial<DialogueTiming>;
}

type Mode =
  | 'idle'
  | 'open'
  | 'awaitingTicketConfirm'
  | 'awaitingEmail'
  | 'creatingTicket'
  | 'closing'
  | 'done';

interface PendingTurn {
  id: number;
  transcript: string;
  /** When the caller stopped talking: the base for "hold on". */
  speechEndAt: number;
  /** A wait line was said, so the answer opens with "thank you for waiting". */
  holdOnSaid: boolean;
  /** The brain answered while a wait line was still playing; applied when it ends. */
  result: BrainOutcome | null;
}

export interface DialogueSnapshot {
  mode: Mode;
  language: Language;
  speaking: UtteranceKind | null;
  thinking: boolean;
  queued: number;
  handoff: 'none' | 'ringing';
  utterances: number;
}

export class Dialogue {
  private readonly timing: DialogueTiming;
  private mode: Mode = 'idle';
  private language: Language;
  private visitorEmail: string | null;
  private speaking: Utterance | null = null;
  private turn: PendingTurn | null = null;
  private queue: string[] = [];
  private handoff: 'none' | 'ringing' = 'none';
  private handoffFailedPending = false;
  private stillThereSaid = false;
  private lastSpeechEndAt: number | null = null;
  private readonly utterances: string[] = [];
  private nextId = 1;
  private now = 0;
  private actions: DialogueAction[] = [];

  constructor(private readonly options: DialogueOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.language = options.language;
    this.visitorEmail = options.visitorEmail;
  }

  /** One event in, the actions it causes out. `now` is a monotonic millisecond reading. */
  handle(event: DialogueEvent, now: number): DialogueAction[] {
    this.now = now;
    this.actions = [];
    if (this.mode !== 'done') this.dispatch(event);
    const out = this.actions;
    this.actions = [];
    return out;
  }

  snapshot(): DialogueSnapshot {
    return {
      mode: this.mode,
      language: this.language,
      speaking: this.speaking?.kind ?? null,
      thinking: this.turn !== null,
      queued: this.queue.length,
      handoff: this.handoff,
      utterances: this.utterances.length,
    };
  }

  // ---------------------------------------------------------------------------

  private dispatch(event: DialogueEvent): void {
    switch (event.type) {
      case 'start':
        this.mode = 'open';
        this.setTimer('maxLength', this.options.aiMaxSeconds * 1_000);
        this.speak('greeting', [{ line: { phrase: 'greeting' }, post: true }]);
        return;
      case 'speech_start':
        this.onSpeechStart();
        return;
      case 'speech_cancel':
        // A false alarm. The silence clock stopped at the start; it has to start again.
        this.clearTimer('bargeIn');
        this.settle();
        return;
      case 'speech_end':
        this.lastSpeechEndAt = this.now;
        return;
      case 'transcript':
        this.onTranscript(event.text, event.language);
        return;
      case 'chat_message':
        this.onChatMessage(event.text);
        return;
      case 'speech_done':
        this.onSpeechDone(event.id);
        return;
      case 'brain_result':
        this.onBrain(event.turnId, event.outcome);
        return;
      case 'brain_failed':
        this.onBrain(event.turnId, { kind: 'unavailable', spoken: '', goodbye: false });
        return;
      case 'human_requested':
        this.onHumanRequested(event.rung);
        return;
      case 'call_updated':
        this.onCallUpdated(event.status, event.handledByAi);
        return;
      case 'ticket_created':
        if (this.mode !== 'creatingTicket') return;
        this.mode = 'open';
        this.speak('ticket', [
          {
            line: { phrase: 'ticketCreated', number: event.number, email: event.email },
            post: true,
          },
        ]);
        return;
      case 'ticket_failed':
        if (this.mode !== 'creatingTicket') return;
        this.mode = 'open';
        this.speak('ticket', [{ line: { fixed: 'ticketFailed' }, post: true }]);
        return;
      case 'timer':
        this.onTimer(event.name);
        return;
      case 'visitor_left':
      case 'disconnected':
        this.finish('completed');
        return;
      default:
        return;
    }
  }

  // --- the caller's voice ------------------------------------------------------

  private onSpeechStart(): void {
    // The caller is talking: whatever silence was being measured is over.
    this.clearTimer('silence');
    const current = this.speaking;
    if (!current || !current.interruptible) return;
    // "Hello?" over the first words of the greeting is a caller checking the line is live, not an
    // interruption; the greeting carries on and their words are read when they come.
    if (current.kind === 'greeting' && this.now - current.startedAt < this.timing.greetingGuardMs)
      return;
    this.setTimer('bargeIn', this.timing.bargeInConfirmMs);
  }

  private interrupt(): void {
    const current = this.speaking;
    if (!current) return;
    this.speaking = null;
    this.emit({ type: 'stop_speaking' });
    // The caller spoke over the goodbye: they are not done, so neither is the call. Anything the
    // utterance was going to lead to - ringing the team, hanging up - is dropped with it; what
    // the caller says next decides what happens.
    if (current.kind === 'goodbye' && this.mode === 'closing') {
      this.mode = 'open';
      this.stillThereSaid = false;
    }
  }

  private onTranscript(raw: string, language: Language): void {
    if (this.mode === 'idle' || this.mode === 'closing') return;
    const text = raw.trim();
    if (!text) {
      this.settle();
      return;
    }
    if (language !== this.language) {
      this.language = language;
      this.emit({ type: 'set_language', language });
    }
    // Somebody is there: the silence clock stops, and starts again when the line goes quiet.
    this.stillThereSaid = false;
    this.clearTimer('silence');

    if (this.turn) {
      // The brain is busy. A sound that asks for nothing is ignored; a real question waits its
      // turn, and the caller is told so unless a wait line is already playing.
      if (isFiller(text)) return;
      this.enqueue(text);
      if (!this.speaking) {
        this.turn.holdOnSaid = true;
        this.speak('stillChecking', [{ line: { phrase: 'stillChecking' }, post: false }]);
      }
      return;
    }
    if (this.speaking) {
      // Words over the voice that the barge-in did not catch - too short for its window, or
      // said during the guarded opening of the greeting. A "hello" changes nothing; anything
      // else is what the caller wanted said, so the voice stops and it is taken as it stands.
      if (isFiller(text)) return;
      if (!this.speaking.interruptible) return;
      this.interrupt();
    }
    if (this.mode === 'creatingTicket') {
      this.enqueue(text);
      return;
    }

    switch (this.mode) {
      case 'awaitingTicketConfirm': {
        const answer = classifyYesNo(text);
        if (answer === 'yes') {
          this.beginTicket();
        } else if (answer === 'no') {
          this.mode = 'open';
          this.speak('ticket', [{ line: { phrase: 'ticketDeclined' }, post: true }]);
        } else {
          // Neither: the caller moved on to something else, and so does the assistant.
          this.mode = 'open';
          this.startTurn(text);
        }
        return;
      }
      case 'awaitingEmail':
        if (isCancel(text)) {
          this.clearTimer('emailWait');
          this.mode = 'open';
          this.speak('ticket', [{ line: { phrase: 'ticketDeclined' }, post: true }]);
        } else {
          this.speak('ticket', [{ line: { phrase: 'ticketAskEmail' }, post: false }]);
        }
        return;
      default:
        this.startTurn(text);
    }
  }

  private onChatMessage(text: string): void {
    if (this.mode !== 'awaitingEmail') return;
    const email = extractEmail(text);
    if (!email) return;
    this.clearTimer('emailWait');
    this.visitorEmail = email;
    this.mode = 'creatingTicket';
    this.emit({ type: 'create_ticket', email, identify: true, questions: this.lastQuestions() });
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    while (this.queue.length > this.timing.maxQueued) this.queue.shift();
  }

  // --- the brain -----------------------------------------------------------------

  private startTurn(text: string): void {
    this.utterances.push(text);
    this.clearTimer('silence');
    const id = this.nextId++;
    const speechEndAt = this.lastSpeechEndAt ?? this.now;
    this.lastSpeechEndAt = null;
    this.turn = { id, transcript: text, speechEndAt, holdOnSaid: false, result: null };
    this.emit({ type: 'brain', turnId: id, transcript: text, language: this.language });
    // "Hold on" is only promised for something worth looking up: saying it before answering
    // "hello" would be absurd, and the wait is measured from when the caller stopped talking,
    // not from when the words arrived, because that is the silence they are sitting in.
    if (this.options.looksLikeLookup(text)) {
      const due = this.timing.holdOnMs - (this.now - speechEndAt);
      if (due <= 0) this.sayHoldOn();
      else this.setTimer('holdOn', due);
    }
  }

  private sayHoldOn(): void {
    if (!this.turn || this.turn.result || this.speaking) return;
    this.turn.holdOnSaid = true;
    this.speak('holdOn', [{ line: { phrase: 'holdOn' }, post: false }]);
  }

  private onBrain(turnId: number, outcome: BrainOutcome): void {
    if (!this.turn || this.turn.id !== turnId) return;
    this.clearTimer('holdOn');
    this.turn.result = outcome;
    // A wait line mid-sentence is let finish; the answer follows it.
    if (this.speaking) return;
    this.applyOutcome();
  }

  private applyOutcome(): void {
    const turn = this.turn;
    if (!turn || !turn.result) return;
    this.turn = null;
    const outcome = turn.result;
    const prefix: Part[] = turn.holdOnSaid ? [{ line: { phrase: 'afterWait' }, post: false }] : [];

    switch (outcome.kind) {
      case 'answer':
      case 'chat': {
        if (!outcome.spoken.trim()) {
          this.settle();
          return;
        }
        // A goodbye with a question still waiting is not a goodbye: the caller said something
        // more while the brain was thinking, and leaving now would hang up on it.
        const goodbye = outcome.goodbye && this.queue.length === 0;
        this.speak('answer', [...prefix, { line: { text: outcome.spoken }, post: false }], {
          after: goodbye ? 'goodbye' : 'none',
        });
        return;
      }
      case 'offer':
        // The brain already wrote its offer to the transcript; only the yes-or-no question is new.
        this.mode = 'awaitingTicketConfirm';
        this.speak('ticket', [
          ...prefix,
          ...(outcome.spoken.trim() ? [{ line: { text: outcome.spoken }, post: false }] : []),
          { line: { phrase: 'ticketOffer' }, post: true },
        ]);
        return;
      case 'unavailable':
        this.mode = 'awaitingTicketConfirm';
        this.speak('ticket', [...prefix, { line: { phrase: 'ticketOffer' }, post: true }]);
        return;
      case 'handoff':
        this.speak(
          'handoff',
          [
            ...prefix,
            ...(outcome.spoken.trim() ? [{ line: { text: outcome.spoken }, post: false }] : []),
          ],
          { after: 'request_human' },
        );
        return;
      default:
        this.settle();
    }
  }

  // --- the assistant's voice ----------------------------------------------------

  private onSpeechDone(id: number): void {
    if (!this.speaking || this.speaking.id !== id) return;
    const done = this.speaking;
    this.speaking = null;
    switch (done.kind) {
      case 'goodbye':
      case 'maxLength':
        this.setTimer('hangup', this.timing.hangupGraceMs);
        return;
      case 'handoff':
        if (done.after === 'request_human') {
          this.emit({ type: 'request_human' });
          return;
        }
        break;
      case 'answer':
        if (done.after === 'goodbye') {
          this.sayGoodbye();
          return;
        }
        break;
      case 'holdOn':
      case 'stillChecking':
        if (this.turn) {
          if (this.turn.result) this.applyOutcome();
          return;
        }
        break;
      default:
        break;
    }
    this.settle();
  }

  /**
   * Nothing is being said and nothing is being thought about: what next? A failed hand-over to
   * report, a question that waited its turn, or the silence clock.
   */
  private settle(): void {
    if (this.speaking || this.turn) return;
    if (
      this.mode === 'idle' ||
      this.mode === 'closing' ||
      this.mode === 'done' ||
      this.mode === 'creatingTicket'
    )
      return;
    if (this.handoffFailedPending) {
      this.handoffFailedPending = false;
      this.mode = 'awaitingTicketConfirm';
      this.speak('ticket', [{ line: { phrase: 'handoffFailed' }, post: true }]);
      return;
    }
    if (this.mode === 'open' && this.queue.length > 0) {
      this.startTurn(this.queue.shift()!);
      return;
    }
    if (this.mode === 'awaitingEmail') return;
    // While the team rings the caller is not alone, and "are you still there?" would be odd.
    if (this.handoff === 'ringing') return;
    this.setTimer(
      'silence',
      this.stillThereSaid ? this.timing.silenceAfterNudgeMs : this.timing.silenceMs,
    );
  }

  private sayGoodbye(): void {
    this.mode = 'closing';
    this.clearTimer('silence');
    this.clearTimer('holdOn');
    this.clearTimer('emailWait');
    this.queue = [];
    this.turn = null;
    this.speak('goodbye', [{ line: { phrase: 'goodbye' }, post: true }]);
  }

  // --- the team and the ticket --------------------------------------------------

  private onHumanRequested(rung: number): void {
    if (this.mode === 'closing') return;
    if (rung === 0) {
      this.mode = 'awaitingTicketConfirm';
      this.speak('ticket', [{ line: { phrase: 'noAgent' }, post: true }]);
      return;
    }
    this.handoff = 'ringing';
    this.settle();
  }

  private onCallUpdated(status: CallStatus, handledByAi: boolean): void {
    if (status === 'ended') {
      this.finish('completed');
      return;
    }
    if (this.handoff !== 'ringing') return;
    // A person took the call: the room removes the AI next, and there is nothing left to say.
    if (!handledByAi) {
      this.finish('completed');
      return;
    }
    if (status === 'active') {
      // Nobody picked up and the call came back. Said now if the line is quiet, or as soon as it is.
      this.handoff = 'none';
      if (this.speaking || this.turn) this.handoffFailedPending = true;
      else {
        this.mode = 'awaitingTicketConfirm';
        this.speak('ticket', [{ line: { phrase: 'handoffFailed' }, post: true }]);
      }
    }
  }

  private beginTicket(): void {
    if (this.visitorEmail) {
      this.mode = 'creatingTicket';
      this.emit({
        type: 'create_ticket',
        email: this.visitorEmail,
        identify: false,
        questions: this.lastQuestions(),
      });
      return;
    }
    this.mode = 'awaitingEmail';
    this.setTimer('emailWait', this.timing.emailWaitMs);
    this.speak('ticket', [{ line: { phrase: 'ticketAskEmail' }, post: true }]);
  }

  private lastQuestions(): string[] {
    return this.utterances.slice(-3);
  }

  // --- timers --------------------------------------------------------------------

  private onTimer(name: TimerName): void {
    switch (name) {
      case 'holdOn':
        this.sayHoldOn();
        return;
      case 'bargeIn':
        if (this.speaking?.interruptible) this.interrupt();
        return;
      case 'silence':
        if (this.speaking || this.turn || this.mode === 'closing') return;
        if (this.stillThereSaid) {
          this.sayGoodbye();
        } else {
          this.stillThereSaid = true;
          this.speak('stillThere', [{ line: { phrase: 'stillThere' }, post: true }]);
        }
        return;
      case 'emailWait':
        if (this.mode !== 'awaitingEmail') return;
        this.mode = 'open';
        this.speak('ticket', [{ line: { fixed: 'noEmail' }, post: true }]);
        return;
      case 'maxLength':
        this.onMaxLength();
        return;
      case 'hangup':
        this.finish('ai_ended');
        return;
      default:
        return;
    }
  }

  private onMaxLength(): void {
    if (this.mode === 'closing') return;
    this.mode = 'closing';
    this.turn = null;
    this.queue = [];
    this.handoffFailedPending = false;
    for (const name of ['silence', 'holdOn', 'emailWait', 'bargeIn'] as const)
      this.clearTimer(name);
    this.speak('maxLength', [{ line: { phrase: 'maxLength' }, post: true }], {
      interruptible: false,
    });
  }

  // --- helpers ---------------------------------------------------------------------

  private speak(
    kind: UtteranceKind,
    parts: Part[],
    options: { interruptible?: boolean; after?: Utterance['after'] } = {},
  ): void {
    if (this.speaking) this.emit({ type: 'stop_speaking' });
    const utterance: Utterance = {
      id: this.nextId++,
      kind,
      language: this.language,
      parts,
      interruptible: options.interruptible ?? true,
      after: options.after ?? 'none',
      startedAt: this.now,
    };
    this.speaking = utterance;
    this.emit({ type: 'speak', utterance });
  }

  private finish(reason: FinishReason): void {
    if (this.mode === 'done') return;
    this.mode = 'done';
    for (const name of [
      'holdOn',
      'bargeIn',
      'silence',
      'emailWait',
      'maxLength',
      'hangup',
    ] as const) {
      this.clearTimer(name);
    }
    if (this.speaking) {
      this.speaking = null;
      this.emit({ type: 'stop_speaking' });
    }
    this.emit({ type: 'finish', reason });
  }

  private setTimer(name: TimerName, ms: number): void {
    this.emit({ type: 'set_timer', name, ms });
  }

  private clearTimer(name: TimerName): void {
    this.emit({ type: 'clear_timer', name });
  }

  private emit(action: DialogueAction): void {
    this.actions.push(action);
  }
}
