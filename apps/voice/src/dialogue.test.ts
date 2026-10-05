import { describe, expect, it } from 'vitest';
import {
  Dialogue,
  type BrainOutcome,
  type DialogueAction,
  type DialogueEvent,
  type DialogueOptions,
  type Line,
  type TimerName,
  type Utterance,
} from './dialogue.js';

/**
 * The rules of a call, run against a fake clock.
 *
 * Every scenario the agent has to get right is here as a sequence of events and the actions
 * expected back: the greeting, a question and its "hold on", a caller talking over the brain
 * and over the voice, the ticket said yes and no to in both languages, an email typed in the
 * chat, a hand-over that works and one that does not, the silence, the time limit. No audio,
 * no model, no clock - the machine is pure, so nothing here waits.
 */

const LOOKUP = (text: string): boolean =>
  text.split(/\s+/).length >= 4 || /\?|what|where|when|how|কি|কোথায়|কখন/u.test(text);

class Harness {
  readonly dialogue: Dialogue;
  now = 0;
  readonly log: DialogueAction[] = [];
  private readonly timers = new Map<TimerName, number>();
  private playing: Utterance | null = null;

  constructor(options: Partial<DialogueOptions> = {}) {
    this.dialogue = new Dialogue({
      language: 'en',
      visitorEmail: null,
      aiMaxSeconds: 600,
      looksLikeLookup: LOOKUP,
      ...options,
    });
  }

  /** Feed one event; the actions it produced come back and are also kept in `log`. */
  send(event: DialogueEvent): DialogueAction[] {
    if (event.type === 'speech_done' && this.playing?.id === event.id) this.playing = null;
    const actions = this.dialogue.handle(event, this.now);
    for (const action of actions) {
      if (action.type === 'set_timer') this.timers.set(action.name, this.now + action.ms);
      if (action.type === 'clear_timer') this.timers.delete(action.name);
      if (action.type === 'speak') this.playing = action.utterance;
      if (action.type === 'stop_speaking') this.playing = null;
      this.log.push(action);
    }
    return actions;
  }

  /** Move the clock, firing timers as they come due, in order. */
  advance(ms: number): DialogueAction[] {
    const target = this.now + ms;
    const fired: DialogueAction[] = [];
    for (;;) {
      let next: { name: TimerName; at: number } | null = null;
      for (const [name, at] of this.timers) {
        if (at <= target && (!next || at < next.at)) next = { name, at };
      }
      if (!next) break;
      this.timers.delete(next.name);
      this.now = next.at;
      fired.push(...this.send({ type: 'timer', name: next.name }));
    }
    this.now = target;
    return fired;
  }

  timer(name: TimerName): number | undefined {
    const at = this.timers.get(name);
    return at === undefined ? undefined : at - this.now;
  }

  speaks(): Utterance[] {
    return this.log.flatMap((action) => (action.type === 'speak' ? [action.utterance] : []));
  }

  lastSpeak(): Utterance {
    const all = this.speaks();
    const last = all[all.length - 1];
    if (!last) throw new Error('nothing was spoken');
    return last;
  }

  /** The utterance playing right now: spoken, not stopped, not yet reported done. */
  current(): Utterance | null {
    return this.playing;
  }

  /** The current utterance was heard in full. */
  finishSpeaking(): DialogueAction[] {
    const current = this.current();
    if (!current) throw new Error('nothing is being spoken');
    return this.send({ type: 'speech_done', id: current.id, completed: true });
  }

  brains(): Array<{ turnId: number; transcript: string; language: string }> {
    return this.log.flatMap((action) =>
      action.type === 'brain'
        ? [{ turnId: action.turnId, transcript: action.transcript, language: action.language }]
        : [],
    );
  }

  lastBrain(): { turnId: number; transcript: string; language: string } {
    const all = this.brains();
    const last = all[all.length - 1];
    if (!last) throw new Error('the brain was not asked');
    return last;
  }

  answer(outcome: Partial<BrainOutcome> & { spoken: string }): DialogueAction[] {
    return this.send({
      type: 'brain_result',
      turnId: this.lastBrain().turnId,
      outcome: { kind: 'answer', goodbye: false, ...outcome },
    });
  }

  finished(): DialogueAction | undefined {
    return this.log.find((action) => action.type === 'finish');
  }

  has(type: DialogueAction['type']): boolean {
    return this.log.some((action) => action.type === type);
  }

  /** A whole opening: greeting said and heard, the line now quiet. */
  opened(): this {
    this.send({ type: 'start' });
    this.advance(3_000);
    this.finishSpeaking();
    return this;
  }

  /**
   * The caller asks something: the end of their speech, then the transcript a little later.
   * With the default transcription delay, "hold on" is due 600 ms after the words arrive.
   */
  asks(text: string, language: 'en' | 'bn' = 'en', sttMs = 1_200): DialogueAction[] {
    this.send({ type: 'speech_start' });
    this.advance(1_500);
    this.send({ type: 'speech_end' });
    this.advance(sttMs);
    return this.send({ type: 'transcript', text, language });
  }
}

const lines = (utterance: Utterance): Line[] => utterance.parts.map((part) => part.line);
const phrases = (utterance: Utterance): string[] =>
  utterance.parts.map((part) =>
    'phrase' in part.line
      ? part.line.phrase
      : 'text' in part.line
        ? `text:${part.line.text}`
        : `fixed:${part.line.fixed}`,
  );
const posted = (utterance: Utterance): string[] =>
  utterance.parts
    .filter((part) => part.post)
    .map((part) =>
      'phrase' in part.line
        ? part.line.phrase
        : 'text' in part.line
          ? part.line.text
          : part.line.fixed,
    );

describe('the greeting', () => {
  it('greets, posts the greeting, arms the time limit and then listens for silence', () => {
    const h = new Harness({ aiMaxSeconds: 120 });
    h.send({ type: 'start' });
    expect(phrases(h.lastSpeak())).toEqual(['greeting']);
    expect(posted(h.lastSpeak())).toEqual(['greeting']);
    expect(h.lastSpeak().kind).toBe('greeting');
    expect(h.timer('maxLength')).toBe(120_000);
    h.finishSpeaking();
    expect(h.timer('silence')).toBe(15_000);
  });

  it('is not cut by a "hello?" in its first second and a half, but is afterwards', () => {
    const h = new Harness();
    h.send({ type: 'start' });
    h.advance(500);
    h.send({ type: 'speech_start' });
    expect(h.timer('bargeIn')).toBeUndefined();
    h.advance(1_500);
    h.send({ type: 'speech_start' });
    expect(h.timer('bargeIn')).toBe(300);
    h.advance(300);
    expect(h.has('stop_speaking')).toBe(true);
    expect(h.current()).toBeNull();
  });

  it('lets a "hello" over the greeting pass, but a real question stops it and is answered', () => {
    const h = new Harness();
    h.send({ type: 'start' });
    h.advance(400);
    h.send({ type: 'speech_start' });
    h.advance(1_000);
    h.send({ type: 'speech_end' });
    h.advance(700);
    h.send({ type: 'transcript', text: 'hello', language: 'en' });
    expect(h.brains()).toHaveLength(0);
    expect(h.current()?.kind).toBe('greeting');
    h.send({ type: 'transcript', text: 'I need help with my invoice', language: 'en' });
    expect(h.has('stop_speaking')).toBe(true);
    expect(h.brains().map((turn) => turn.transcript)).toEqual(['I need help with my invoice']);
  });
});

describe('a question', () => {
  it('asks the brain, says "hold on" 1.8 s after the caller stopped, and thanks them for waiting', () => {
    const h = new Harness().opened();
    h.send({ type: 'speech_start' });
    expect(h.timer('silence')).toBeUndefined();
    h.advance(2_000);
    h.send({ type: 'speech_end' });
    h.advance(1_500);
    h.send({ type: 'transcript', text: 'what are your opening hours on friday', language: 'en' });
    expect(h.lastBrain().transcript).toBe('what are your opening hours on friday');
    // 1.8 s after speech_end, of which 1.5 s was the transcription.
    expect(h.timer('holdOn')).toBe(300);
    h.advance(300);
    expect(h.lastSpeak().kind).toBe('holdOn');
    expect(posted(h.lastSpeak())).toEqual([]);

    // The answer arrives while "hold on" is still playing: it waits for the line to end.
    h.advance(1_000);
    h.answer({ spoken: 'We open at nine on Fridays.' });
    expect(h.lastSpeak().kind).toBe('holdOn');
    h.finishSpeaking();
    expect(h.lastSpeak().kind).toBe('answer');
    expect(phrases(h.lastSpeak())).toEqual(['afterWait', 'text:We open at nine on Fridays.']);
    expect(posted(h.lastSpeak())).toEqual([]);
    h.finishSpeaking();
    expect(h.timer('silence')).toBe(15_000);
  });

  it('says "hold on" at once when the words arrive later than 1.8 s after the caller stopped', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday', 'en', 2_500);
    expect(h.lastSpeak().kind).toBe('holdOn');
    expect(h.timer('holdOn')).toBeUndefined();
  });

  it('does not promise to check a greeting, and answers it without "thank you for waiting"', () => {
    const h = new Harness().opened();
    h.asks('hello there');
    expect(h.timer('holdOn')).toBeUndefined();
    h.advance(5_000);
    h.answer({ kind: 'chat', spoken: 'Hello! How can I help?' });
    expect(phrases(h.lastSpeak())).toEqual(['text:Hello! How can I help?']);
  });

  it('ignores an empty transcript and goes back to measuring silence', () => {
    const h = new Harness().opened();
    h.send({ type: 'speech_start' });
    h.send({ type: 'speech_end' });
    h.send({ type: 'transcript', text: '   ', language: 'en' });
    expect(h.brains()).toHaveLength(0);
    expect(h.timer('silence')).toBe(15_000);
  });

  it('hangs up after an answer the brain marked as a goodbye', () => {
    const h = new Harness().opened();
    h.asks('thanks that is all');
    h.answer({ kind: 'chat', spoken: 'You are welcome.', goodbye: true });
    h.finishSpeaking();
    expect(phrases(h.lastSpeak())).toEqual(['goodbye']);
    expect(posted(h.lastSpeak())).toEqual(['goodbye']);
    h.finishSpeaking();
    expect(h.timer('hangup')).toBe(800);
    h.advance(800);
    expect(h.finished()).toEqual({ type: 'finish', reason: 'ai_ended' });
  });

  it('offers a ticket when the brain could not be reached', () => {
    const h = new Harness().opened();
    h.asks('what is the price of the premium plan');
    h.send({ type: 'brain_failed', turnId: h.lastBrain().turnId });
    expect(phrases(h.lastSpeak())).toEqual(['ticketOffer']);
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
  });
});

describe('talking over the brain', () => {
  it('ignores filler, queues a real question with "still checking", and answers it after', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    const first = h.lastBrain().turnId;
    h.advance(600);
    expect(h.current()?.kind).toBe('holdOn');
    h.finishSpeaking();

    const before = h.log.length;
    h.send({ type: 'transcript', text: 'hello?', language: 'en' });
    h.send({ type: 'transcript', text: 'ঠিক আছে', language: 'bn' });
    // Nothing but housekeeping: no speech, no second brain turn, no queue.
    expect(
      h.log
        .slice(before)
        .filter((action) => action.type !== 'set_language' && action.type !== 'clear_timer'),
    ).toEqual([]);
    expect(h.dialogue.snapshot().queued).toBe(0);

    h.send({ type: 'transcript', text: 'and do you deliver to Sylhet', language: 'bn' });
    expect(h.lastSpeak().kind).toBe('stillChecking');
    expect(posted(h.lastSpeak())).toEqual([]);
    expect(h.dialogue.snapshot().queued).toBe(1);
    h.finishSpeaking();

    h.send({
      type: 'brain_result',
      turnId: first,
      outcome: { kind: 'answer', spoken: 'Nine to five.', goodbye: false },
    });
    expect(phrases(h.lastSpeak())).toEqual(['afterWait', 'text:Nine to five.']);
    expect(h.brains()).toHaveLength(1);
    h.finishSpeaking();
    expect(h.brains()).toHaveLength(2);
    expect(h.lastBrain()).toMatchObject({
      transcript: 'and do you deliver to Sylhet',
      language: 'bn',
    });
    expect(h.dialogue.snapshot().queued).toBe(0);
  });

  it('keeps only the two latest questions', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    h.advance(600);
    h.finishSpeaking();
    h.send({ type: 'transcript', text: 'first extra question please', language: 'en' });
    h.finishSpeaking();
    h.send({ type: 'transcript', text: 'second extra question please', language: 'en' });
    h.finishSpeaking();
    h.send({ type: 'transcript', text: 'third extra question please', language: 'en' });
    h.finishSpeaking();
    h.answer({ spoken: 'Nine to five.' });
    h.finishSpeaking();
    h.answer({ spoken: 'Second.' });
    h.finishSpeaking();
    h.answer({ spoken: 'Third.' });
    h.finishSpeaking();
    expect(h.brains().map((turn) => turn.transcript)).toEqual([
      'what are your opening hours on friday',
      'second extra question please',
      'third extra question please',
    ]);
  });

  it('does not say goodbye while a question is still waiting', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    h.advance(600);
    h.finishSpeaking();
    h.send({ type: 'transcript', text: 'and where is your office located', language: 'en' });
    h.finishSpeaking();
    h.answer({ spoken: 'Nine to five, bye!', goodbye: true });
    h.finishSpeaking();
    expect(h.lastSpeak().kind).not.toBe('goodbye');
    expect(h.lastBrain().transcript).toBe('and where is your office located');
  });
});

describe('talking over the voice', () => {
  it('stops the answer once the caller has talked for 300 ms, then answers what they said', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    h.answer({
      spoken: 'We are open from nine to five, Monday to Friday, and closed at the weekend.',
    });
    expect(h.current()?.kind).toBe('answer');
    h.send({ type: 'speech_start' });
    expect(h.timer('bargeIn')).toBe(300);
    h.advance(300);
    expect(h.log[h.log.length - 1]).toEqual({ type: 'stop_speaking' });
    expect(h.current()).toBeNull();
    h.advance(1_000);
    h.send({ type: 'speech_end' });
    h.advance(800);
    h.send({ type: 'transcript', text: 'sorry what about saturday', language: 'en' });
    expect(h.lastBrain().transcript).toBe('sorry what about saturday');
  });

  it('lets a cough pass: a start cancelled within the window does not stop the voice', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    h.answer({ spoken: 'Nine to five.' });
    h.send({ type: 'speech_start' });
    h.advance(200);
    h.send({ type: 'speech_cancel' });
    h.advance(500);
    expect(h.has('stop_speaking')).toBe(false);
    expect(h.current()?.kind).toBe('answer');
  });

  it('takes a short "no" that the barge-in window missed as the answer to the ticket question', () => {
    const h = new Harness().opened();
    h.asks('can you check order four five six for me');
    h.answer({ kind: 'offer', spoken: 'I cannot see orders.' });
    expect(h.current()?.kind).toBe('ticket');
    h.send({ type: 'speech_start' });
    h.advance(100);
    h.send({ type: 'speech_end' });
    h.advance(800);
    h.send({ type: 'transcript', text: 'no', language: 'en' });
    expect(h.has('stop_speaking')).toBe(true);
    expect(phrases(h.lastSpeak())).toEqual(['ticketDeclined']);
  });

  it('may interrupt the ticket question without losing the question', () => {
    const h = new Harness({ visitorEmail: 'ana@example.com' }).opened();
    h.asks('what are your opening hours on friday');
    h.answer({ kind: 'offer', spoken: 'I could not find that.' });
    h.send({ type: 'speech_start' });
    h.advance(300);
    expect(h.current()).toBeNull();
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
    h.send({ type: 'speech_end' });
    h.send({ type: 'transcript', text: 'yes', language: 'en' });
    expect(h.has('create_ticket')).toBe(true);
  });

  it('calls off the goodbye when the caller speaks over it', () => {
    const h = new Harness().opened();
    h.asks('thanks bye');
    h.answer({ kind: 'chat', spoken: 'Bye!', goodbye: true });
    h.finishSpeaking();
    expect(h.lastSpeak().kind).toBe('goodbye');
    h.send({ type: 'speech_start' });
    h.advance(300);
    h.send({ type: 'speech_end' });
    h.send({ type: 'transcript', text: 'wait one more thing about delivery', language: 'en' });
    expect(h.lastBrain().transcript).toBe('wait one more thing about delivery');
    expect(h.finished()).toBeUndefined();
  });
});

describe('the ticket', () => {
  function offered(options: Partial<DialogueOptions> = {}): Harness {
    const h = new Harness(options).opened();
    h.asks('can you check the status of order number four five six');
    h.answer({ kind: 'offer', spoken: 'I cannot see orders from here.' });
    return h;
  }

  it("speaks the brain's offer and then the yes-or-no question, posting only the question", () => {
    const h = offered();
    expect(h.lastSpeak().kind).toBe('ticket');
    expect(phrases(h.lastSpeak())).toEqual(['text:I cannot see orders from here.', 'ticketOffer']);
    expect(posted(h.lastSpeak())).toEqual(['ticketOffer']);
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
  });

  it('creates the ticket on a yes when the email is known, with the last questions', () => {
    const h = offered({ visitorEmail: 'ana@example.com' });
    h.finishSpeaking();
    h.asks('yes please');
    expect(h.log[h.log.length - 1]).toEqual({
      type: 'create_ticket',
      email: 'ana@example.com',
      identify: false,
      questions: ['can you check the status of order number four five six'],
    });
    h.send({ type: 'ticket_created', number: 42, email: 'ana@example.com' });
    expect(lines(h.lastSpeak())).toEqual([
      { phrase: 'ticketCreated', number: 42, email: 'ana@example.com' },
    ]);
    expect(posted(h.lastSpeak())).toEqual(['ticketCreated']);
    h.finishSpeaking();
    expect(h.dialogue.snapshot().mode).toBe('open');
    expect(h.timer('silence')).toBe(15_000);
  });

  it('understands a yes and a no in Bengali', () => {
    const yes = offered({ visitorEmail: 'ana@example.com' });
    yes.finishSpeaking();
    yes.asks('জি, করুন', 'bn');
    expect(yes.has('create_ticket')).toBe(true);

    const no = offered();
    no.finishSpeaking();
    no.asks('না, দরকার নেই', 'bn');
    expect(phrases(no.lastSpeak())).toEqual(['ticketDeclined']);
    expect(no.lastSpeak().language).toBe('bn');
    expect(no.has('create_ticket')).toBe(false);
  });

  it('takes a no in English and goes back to listening', () => {
    const h = offered();
    h.finishSpeaking();
    h.asks('no thanks');
    expect(phrases(h.lastSpeak())).toEqual(['ticketDeclined']);
    expect(posted(h.lastSpeak())).toEqual(['ticketDeclined']);
    h.finishSpeaking();
    expect(h.dialogue.snapshot().mode).toBe('open');
  });

  it('treats anything else as a new question', () => {
    const h = offered();
    h.finishSpeaking();
    h.asks('actually what time do you close today');
    expect(h.lastBrain().transcript).toBe('actually what time do you close today');
    expect(h.dialogue.snapshot().mode).toBe('open');
  });

  it('asks for the email in the chat box when it is unknown, and makes the ticket when it arrives', () => {
    const h = offered();
    h.finishSpeaking();
    h.asks('yes');
    expect(phrases(h.lastSpeak())).toEqual(['ticketAskEmail']);
    expect(posted(h.lastSpeak())).toEqual(['ticketAskEmail']);
    expect(h.timer('emailWait')).toBe(120_000);
    h.finishSpeaking();

    // Spoken words are not an email; the question is repeated without being posted again.
    h.asks('it is ana at example dot com');
    expect(phrases(h.lastSpeak())).toEqual(['ticketAskEmail']);
    expect(posted(h.lastSpeak())).toEqual([]);
    h.finishSpeaking();

    h.send({ type: 'chat_message', text: 'My email: Ana@Example.com thanks' });
    expect(h.log[h.log.length - 1]).toEqual({
      type: 'create_ticket',
      email: 'ana@example.com',
      identify: true,
      questions: ['can you check the status of order number four five six'],
    });
    expect(h.timer('emailWait')).toBeUndefined();
    h.send({ type: 'ticket_created', number: 7, email: 'ana@example.com' });
    expect(lines(h.lastSpeak())).toEqual([
      { phrase: 'ticketCreated', number: 7, email: 'ana@example.com' },
    ]);
  });

  it('abandons the ticket on "cancel" while waiting for the email', () => {
    const h = offered();
    h.finishSpeaking();
    h.asks('yes');
    h.finishSpeaking();
    h.asks('cancel');
    expect(phrases(h.lastSpeak())).toEqual(['ticketDeclined']);
    expect(h.timer('emailWait')).toBeUndefined();
    expect(h.dialogue.snapshot().mode).toBe('open');
  });

  it('gives up on the email after two minutes with the fixed line', () => {
    const h = offered();
    h.finishSpeaking();
    h.asks('yes');
    h.finishSpeaking();
    h.advance(120_000);
    expect(lines(h.lastSpeak())).toEqual([{ fixed: 'noEmail' }]);
    expect(posted(h.lastSpeak())).toEqual(['noEmail']);
    expect(h.dialogue.snapshot().mode).toBe('open');
  });

  it('says so when the ticket could not be made', () => {
    const h = offered({ visitorEmail: 'ana@example.com' });
    h.finishSpeaking();
    h.asks('yes');
    h.send({ type: 'ticket_failed' });
    expect(lines(h.lastSpeak())).toEqual([{ fixed: 'ticketFailed' }]);
    expect(h.dialogue.snapshot().mode).toBe('open');
  });

  it('offers a ticket when the brain says it is unavailable', () => {
    const h = new Harness().opened();
    h.asks('what are your opening hours on friday');
    h.answer({ kind: 'unavailable', spoken: '' });
    expect(phrases(h.lastSpeak())).toEqual(['ticketOffer']);
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
  });
});

describe('handing over to a person', () => {
  function handingOff(): Harness {
    const h = new Harness().opened();
    h.asks('I want to talk to a real person');
    h.answer({ kind: 'handoff', spoken: 'Let me connect you to the team.' });
    expect(h.lastSpeak().kind).toBe('handoff');
    expect(posted(h.lastSpeak())).toEqual([]);
    h.finishSpeaking();
    expect(h.log[h.log.length - 1]).toEqual({ type: 'request_human' });
    return h;
  }

  it('rings the team after the hand-over line and leaves once a person has the call', () => {
    const h = handingOff();
    h.send({ type: 'human_requested', rung: 2 });
    expect(h.dialogue.snapshot().handoff).toBe('ringing');
    expect(h.timer('silence')).toBeUndefined();
    h.send({ type: 'call_updated', status: 'ringing', handledByAi: true });
    expect(h.finished()).toBeUndefined();
    h.send({ type: 'call_updated', status: 'connecting', handledByAi: false });
    expect(h.finished()).toEqual({ type: 'finish', reason: 'completed' });
  });

  it('finishes when the room throws it out', () => {
    const h = handingOff();
    h.send({ type: 'human_requested', rung: 1 });
    h.send({ type: 'disconnected' });
    expect(h.finished()).toEqual({ type: 'finish', reason: 'completed' });
  });

  it('tells the caller when nobody picked up and offers a ticket', () => {
    const h = handingOff();
    h.send({ type: 'human_requested', rung: 2 });
    h.send({ type: 'call_updated', status: 'active', handledByAi: true });
    expect(phrases(h.lastSpeak())).toEqual(['handoffFailed']);
    expect(posted(h.lastSpeak())).toEqual(['handoffFailed']);
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
    expect(h.dialogue.snapshot().handoff).toBe('none');
  });

  it('keeps answering while the team rings, and reports the failure once the answer is out', () => {
    const h = handingOff();
    h.send({ type: 'human_requested', rung: 2 });
    h.asks('while we wait what are your opening hours');
    h.send({ type: 'call_updated', status: 'active', handledByAi: true });
    expect(h.lastSpeak().kind).not.toBe('ticket');
    h.answer({ spoken: 'Nine to five.' });
    h.finishSpeaking();
    expect(phrases(h.lastSpeak())).toEqual(['handoffFailed']);
  });

  it('offers a ticket at once when nobody is online', () => {
    const h = handingOff();
    h.send({ type: 'human_requested', rung: 0 });
    expect(phrases(h.lastSpeak())).toEqual(['noAgent']);
    expect(posted(h.lastSpeak())).toEqual(['noAgent']);
    expect(h.dialogue.snapshot().mode).toBe('awaitingTicketConfirm');
  });
});

describe('silence and endings', () => {
  it('asks whether anyone is there after 15 s, says goodbye 20 s after that, and hangs up', () => {
    const h = new Harness().opened();
    expect(h.timer('silence')).toBe(15_000);
    h.advance(15_000);
    expect(phrases(h.lastSpeak())).toEqual(['stillThere']);
    h.finishSpeaking();
    expect(h.timer('silence')).toBe(20_000);
    h.advance(20_000);
    expect(phrases(h.lastSpeak())).toEqual(['goodbye']);
    h.finishSpeaking();
    h.advance(800);
    expect(h.finished()).toEqual({ type: 'finish', reason: 'ai_ended' });
    // Nothing more comes out of a finished machine.
    expect(h.send({ type: 'transcript', text: 'hello', language: 'en' })).toEqual([]);
  });

  it('starts the silence clock again after a false alarm', () => {
    const h = new Harness().opened();
    h.send({ type: 'speech_start' });
    expect(h.timer('silence')).toBeUndefined();
    h.send({ type: 'speech_cancel' });
    expect(h.timer('silence')).toBe(15_000);
  });

  it('does not count the silence while the caller is answering the ticket question', () => {
    const h = new Harness().opened();
    h.asks('can you check order four five six for me');
    h.answer({ kind: 'offer', spoken: 'I cannot see orders.' });
    h.finishSpeaking();
    expect(h.timer('silence')).toBe(15_000);
    h.asks('yes');
    expect(h.timer('silence')).toBeUndefined();
    expect(h.timer('emailWait')).toBe(120_000);
    h.finishSpeaking();
    expect(h.timer('silence')).toBeUndefined();
  });

  it('starts the silence over when the caller speaks', () => {
    const h = new Harness().opened();
    h.advance(15_000);
    expect(phrases(h.lastSpeak())).toEqual(['stillThere']);
    h.finishSpeaking();
    h.asks('yes I am here what are your hours');
    h.answer({ spoken: 'Nine to five.' });
    h.finishSpeaking();
    expect(h.timer('silence')).toBe(15_000);
  });

  it('ends the call at the time limit, cutting whatever was being said, and cannot be interrupted', () => {
    const h = new Harness({ aiMaxSeconds: 30 }).opened();
    h.asks('what are your opening hours on friday');
    h.answer({ spoken: 'We are open from nine to five.' });
    h.advance(30_000);
    expect(h.has('stop_speaking')).toBe(true);
    expect(phrases(h.lastSpeak())).toEqual(['maxLength']);
    expect(h.lastSpeak().interruptible).toBe(false);
    h.send({ type: 'speech_start' });
    expect(h.timer('bargeIn')).toBeUndefined();
    h.finishSpeaking();
    h.advance(800);
    expect(h.finished()).toEqual({ type: 'finish', reason: 'ai_ended' });
  });

  it('finishes when the visitor leaves or the call is ended elsewhere', () => {
    const left = new Harness().opened();
    left.send({ type: 'visitor_left' });
    expect(left.finished()).toEqual({ type: 'finish', reason: 'completed' });

    const ended = new Harness().opened();
    ended.send({ type: 'call_updated', status: 'ended', handledByAi: true });
    expect(ended.finished()).toEqual({ type: 'finish', reason: 'completed' });
  });

  it('clears every timer when it finishes', () => {
    const h = new Harness().opened();
    h.send({ type: 'visitor_left' });
    expect(h.timer('silence')).toBeUndefined();
    expect(h.timer('maxLength')).toBeUndefined();
  });
});

describe('language', () => {
  it('switches to the language it hears and speaks it from then on', () => {
    const h = new Harness({ language: 'en' }).opened();
    expect(h.lastSpeak().language).toBe('en');
    h.asks('আপনাদের অফিস কোথায়', 'bn');
    expect(h.log.some((action) => action.type === 'set_language' && action.language === 'bn')).toBe(
      true,
    );
    expect(h.lastBrain().language).toBe('bn');
    h.advance(600);
    expect(h.lastSpeak().kind).toBe('holdOn');
    expect(h.lastSpeak().language).toBe('bn');
    h.finishSpeaking();
    h.answer({ spoken: 'ঢাকায়।' });
    expect(h.lastSpeak().language).toBe('bn');
    expect(h.dialogue.snapshot().language).toBe('bn');
  });

  it('does not announce a language it already speaks', () => {
    const h = new Harness({ language: 'bn' }).opened();
    h.asks('আপনাদের অফিস কোথায়', 'bn');
    expect(h.has('set_language')).toBe(false);
  });
});
