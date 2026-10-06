import { describe, expect, it } from 'vitest';
import type { CallDto } from '@smartchat/types';
import {
  IDLE,
  describeDuration,
  elapsedSeconds,
  endedText,
  formatClock,
  isResumable,
  languageHint,
  liveText,
  needsDetailsBeforeCalling,
  reduceCall,
  ringbackFor,
  startFailureText,
  wantsRingback,
  type CallPhase,
} from './call-state.js';

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

const answered = (): CallDto =>
  dto({
    status: 'active',
    answeredByMemberId: 'm1',
    answeredByName: 'Sabbir',
    answeredAt: '2026-10-05T10:00:10.000Z',
  });

function live(call: CallDto, extra: Partial<Extract<CallPhase, { kind: 'live' }>> = {}): CallPhase {
  return { kind: 'live', call, muted: false, room: 'joining', lostText: null, ...extra };
}

describe('reduceCall', () => {
  it('goes idle → starting → live on the server answering, and ends with the ended DTO', () => {
    const starting = reduceCall(IDLE, { type: 'start' });
    expect(starting).toEqual({ kind: 'starting' });

    const ringing = reduceCall(starting, { type: 'started', call: dto() });
    expect(ringing).toEqual(live(dto()));

    const joined = reduceCall(ringing, { type: 'joined' });
    expect(joined).toMatchObject({ kind: 'live', room: 'joined' });

    const active = reduceCall(joined, { type: 'updated', call: answered() });
    expect(active).toMatchObject({ kind: 'live', call: { status: 'active' }, room: 'joined' });

    const ended = dto({
      ...answered(),
      status: 'ended',
      endReason: 'completed',
      durationSeconds: 102,
    });
    expect(reduceCall(active, { type: 'updated', call: ended })).toEqual({
      kind: 'over',
      call: ended,
      text: 'Call ended · 1:42',
    });
  });

  it('treats pressing Call twice as one call', () => {
    expect(reduceCall({ kind: 'starting' }, { type: 'start' })).toEqual({ kind: 'starting' });
    const phase = live(dto());
    expect(reduceCall(phase, { type: 'start' })).toBe(phase);
  });

  it('lets the socket overtake the HTTP response without winding the bar back', () => {
    // The socket's "ringing" arrived while the POST was still in flight ...
    const adopted = reduceCall({ kind: 'starting' }, { type: 'updated', call: dto() });
    expect(adopted).toMatchObject({ kind: 'live', call: { status: 'ringing' } });
    // ... then the agent answered ...
    const active = reduceCall(adopted, { type: 'updated', call: answered() });
    // ... and only then did the POST's stale "ringing" come back.
    expect(reduceCall(active, { type: 'started', call: dto() })).toBe(active);
  });

  it('shows a call missed on the spot from the POST response alone', () => {
    const missed = dto({ status: 'ended', endReason: 'no_answer' });
    expect(reduceCall({ kind: 'starting' }, { type: 'started', call: missed })).toEqual({
      kind: 'over',
      call: missed,
      text: 'Nobody is available right now — leave a message below',
    });
  });

  it('ignores a late event for a call the bar already said was over', () => {
    const ended = dto({ status: 'ended', endReason: 'cancelled' });
    const over: CallPhase = { kind: 'over', call: ended, text: 'Call cancelled' };
    expect(reduceCall(over, { type: 'updated', call: dto() })).toBe(over);
    expect(reduceCall(over, { type: 'resumed', call: dto() })).toBe(over);
  });

  it('leaves a live call it never started alone, and ignores an ended one it never showed', () => {
    expect(reduceCall(IDLE, { type: 'updated', call: dto() })).toBe(IDLE);
    expect(
      reduceCall(IDLE, { type: 'updated', call: dto({ status: 'ended', endReason: 'completed' }) }),
    ).toBe(IDLE);
    const over: CallPhase = {
      kind: 'over',
      call: null,
      text: 'Microphone access is needed to call',
    };
    expect(reduceCall(over, { type: 'updated', call: dto({ id: 'call-2' }) })).toBe(over);
  });

  it('ignores a stale event for a different call while one is on screen', () => {
    const phase = live(dto());
    expect(reduceCall(phase, { type: 'updated', call: dto({ id: 'other' }) })).toBe(phase);
    expect(
      reduceCall(phase, {
        type: 'updated',
        call: dto({ id: 'other', status: 'ended', endReason: 'completed' }),
      }),
    ).toBe(phase);
  });

  it('keeps the lost reason as the last word when the server then ends the call', () => {
    const lost = reduceCall(live(answered(), { room: 'joined' }), {
      type: 'lost',
      text: 'Connection lost',
    });
    expect(lost).toMatchObject({ kind: 'live', room: 'lost', lostText: 'Connection lost' });
    const ended = dto({
      ...answered(),
      status: 'ended',
      endReason: 'visitor_left',
      durationSeconds: 30,
    });
    expect(reduceCall(lost, { type: 'updated', call: ended })).toEqual({
      kind: 'over',
      call: ended,
      text: 'Connection lost',
    });
  });

  it('only mutes and joins a live call', () => {
    expect(reduceCall(IDLE, { type: 'muted', muted: true })).toBe(IDLE);
    expect(reduceCall(IDLE, { type: 'joined' })).toBe(IDLE);
    expect(reduceCall(live(dto()), { type: 'muted', muted: true })).toMatchObject({ muted: true });
  });

  it('ends a call locally only when there is one, and clears the bar after the linger', () => {
    const phase = live(answered());
    expect(reduceCall(phase, { type: 'ended_locally', text: 'Call ended · 0:05' })).toEqual({
      kind: 'over',
      call: answered(),
      text: 'Call ended · 0:05',
    });
    expect(reduceCall(IDLE, { type: 'ended_locally', text: 'x' })).toBe(IDLE);

    const over: CallPhase = { kind: 'over', call: null, text: 'Call minutes used up' };
    expect(reduceCall(over, { type: 'linger_over' })).toBe(IDLE);
    expect(reduceCall(phase, { type: 'linger_over' })).toBe(phase);
  });

  it('turns a failure into a sentence from any phase', () => {
    expect(
      reduceCall(
        { kind: 'starting' },
        { type: 'failed', text: 'Microphone access is needed to call' },
      ),
    ).toEqual({
      kind: 'over',
      call: null,
      text: 'Microphone access is needed to call',
    });
  });
});

describe('ringback', () => {
  it('rings only while the team is being rung for an unanswered call', () => {
    expect(wantsRingback(live(dto()))).toBe(true);
    expect(wantsRingback(live(dto({ status: 'connecting' })))).toBe(false);
    expect(wantsRingback(live(answered()))).toBe(false);
    // A transfer rings too, but the visitor is still talking to somebody.
    expect(
      wantsRingback(
        live(
          dto({
            ...answered(),
            status: 'ringing',
            pending: { kind: 'member', memberId: 'm2', name: 'Mira' },
          }),
        ),
      ),
    ).toBe(false);
    // The AI ringing the team keeps talking meanwhile.
    expect(wantsRingback(live(dto({ ...answered(), status: 'ringing', handledByAi: true })))).toBe(
      false,
    );
    expect(wantsRingback(live(dto(), { room: 'lost' }))).toBe(false);
    expect(wantsRingback({ kind: 'starting' })).toBe(false);
  });

  it('starts when ringing begins and stops the moment the status changes', () => {
    expect(ringbackFor({ kind: 'starting' }, live(dto()))).toBe('start');
    expect(ringbackFor(live(dto()), live(dto(), { room: 'joined' }))).toBe('keep');
    expect(
      ringbackFor(
        live(dto()),
        live(dto({ status: 'connecting', answeredAt: '2026-10-05T10:00:10.000Z' })),
      ),
    ).toBe('stop');
    expect(
      ringbackFor(live(dto()), {
        kind: 'over',
        call: dto({ status: 'ended' }),
        text: 'Missed call',
      }),
    ).toBe('stop');
    expect(ringbackFor(live(dto()), IDLE)).toBe('stop');
    expect(ringbackFor(IDLE, { kind: 'starting' })).toBe('keep');
  });
});

describe('needsDetailsBeforeCalling', () => {
  const base = {
    preChatEnabled: true,
    hasPreChat: false,
    knowsVisitor: false,
    hasVisitorMessages: false,
    preview: false,
  };

  it('asks exactly when the first message would', () => {
    expect(needsDetailsBeforeCalling(base)).toBe(true);
    expect(needsDetailsBeforeCalling({ ...base, preChatEnabled: false })).toBe(false);
    expect(needsDetailsBeforeCalling({ ...base, hasPreChat: true })).toBe(false);
    expect(needsDetailsBeforeCalling({ ...base, knowsVisitor: true })).toBe(false);
    expect(needsDetailsBeforeCalling({ ...base, hasVisitorMessages: true })).toBe(false);
    expect(needsDetailsBeforeCalling({ ...base, preview: true })).toBe(false);
  });
});

describe('resume and language', () => {
  it('resumes only a call that is still going', () => {
    expect(isResumable(null)).toBe(false);
    expect(isResumable(undefined)).toBe(false);
    expect(isResumable({ call: dto({ status: 'ended' }) })).toBe(false);
    expect(isResumable({ call: answered() })).toBe(true);
  });

  it('hints Bengali for a Bengali browser and otherwise leaves the website its default', () => {
    expect(languageHint('bn')).toBe('bn');
    expect(languageHint('bn-BD')).toBe('bn');
    expect(languageHint('en-GB')).toBeUndefined();
    expect(languageHint(undefined)).toBeUndefined();
  });
});

describe('wording', () => {
  it('formats the clock and the spoken duration', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(102)).toBe('1:42');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(describeDuration(45)).toBe('45 s');
    expect(describeDuration(130)).toBe('2 min 10 s');
    expect(describeDuration(120)).toBe('2 min');
    expect(describeDuration(3720)).toBe('1 h 2 min');
  });

  it("counts the call from the server's answer time, not from the panel's", () => {
    const answeredAt = '2026-10-05T10:00:10.000Z';
    expect(elapsedSeconds(answeredAt, Date.parse('2026-10-05T10:01:52.500Z'))).toBe(102);
    expect(elapsedSeconds(null, 0)).toBe(0);
    expect(elapsedSeconds('garbage', 0)).toBe(0);
  });

  it('says what the bar says in each live state', () => {
    expect(liveText(live(dto()) as Extract<CallPhase, { kind: 'live' }>)).toBe('Calling…');
    expect(
      liveText(
        live(dto({ queuedAt: '2026-10-05T10:00:25.000Z' })) as Extract<CallPhase, { kind: 'live' }>,
      ),
    ).toBe('All our lines are busy — please hold…');
    expect(
      liveText(live(dto({ status: 'connecting' })) as Extract<CallPhase, { kind: 'live' }>),
    ).toBe('Connecting…');
    expect(liveText(live(answered()) as Extract<CallPhase, { kind: 'live' }>)).toBe(
      'On a call with Sabbir',
    );
    expect(
      liveText(
        live(dto({ ...answered(), handledByAi: true, answeredByName: 'Mira' })) as Extract<
          CallPhase,
          { kind: 'live' }
        >,
      ),
    ).toBe('Talking to Mira');
    expect(
      liveText(
        live(
          dto({
            ...answered(),
            status: 'ringing',
            pending: { kind: 'member', memberId: 'm2', name: 'Mira' },
          }),
        ) as Extract<CallPhase, { kind: 'live' }>,
      ),
    ).toBe('Transferring to Mira…');
    expect(
      liveText(
        live(
          dto({
            ...answered(),
            status: 'connecting',
            handledByAi: true,
            answeredByName: 'Assistant',
            pending: { kind: 'ai' },
          }),
        ) as Extract<CallPhase, { kind: 'live' }>,
      ),
    ).toBe('Transferring to Assistant…');
    expect(
      liveText(
        live(dto({ ...answered(), status: 'ringing', handledByAi: true })) as Extract<
          CallPhase,
          { kind: 'live' }
        >,
      ),
    ).toBe('Finding someone for you…');
    expect(
      liveText(
        live(answered(), { room: 'lost', lostText: 'Connection lost' }) as Extract<
          CallPhase,
          { kind: 'live' }
        >,
      ),
    ).toBe('Connection lost');
  });

  it('says why a call ended', () => {
    expect(endedText(dto({ status: 'ended', endReason: 'no_answer' }))).toBe(
      'Nobody is available right now — leave a message below',
    );
    expect(endedText(dto({ status: 'ended', endReason: 'busy' }))).toBe(
      'All our lines are busy — please try again soon, or leave a message below',
    );
    expect(endedText(dto({ status: 'ended', endReason: 'declined' }))).toBe('Missed call');
    expect(endedText(dto({ status: 'ended', endReason: 'cancelled' }))).toBe('Call cancelled');
    expect(endedText(dto({ status: 'ended', endReason: 'failed' }))).toBe(
      'The call could not be connected',
    );
    expect(
      endedText(
        dto({ ...answered(), status: 'ended', endReason: 'agent_left', durationSeconds: 130 }),
      ),
    ).toBe('Call ended · 2:10');
    expect(
      endedText(
        dto({ ...answered(), status: 'ended', endReason: 'allowance', durationSeconds: 61 }),
      ),
    ).toBe('Call ended · 1:01 · Call minutes used up');
  });

  it('says why a call could not start', () => {
    expect(startFailureText({ code: 'PLAN_LIMIT_REACHED', status: 402 })).toBe(
      'Call minutes used up',
    );
    expect(startFailureText({ code: 'FEATURE_NOT_IN_PLAN', status: 402 })).toBe(
      'Calling is not available on this website',
    );
    expect(startFailureText({ code: 'FEATURE_NOT_AVAILABLE', status: 403 })).toBe(
      'Calling is not available on this website',
    );
    expect(startFailureText({ code: 'RATE_LIMITED', status: 429 })).toBe(
      'Too many calls. Please try again in a moment.',
    );
    expect(startFailureText({ code: 'NETWORK_ERROR', status: 0 })).toBe(
      'We could not reach the call service. Please try again.',
    );
    expect(startFailureText(null)).toBe('We could not start the call. Please try again.');
  });
});
