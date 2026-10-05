import { describe, expect, it } from 'vitest';
import type { CallDto } from '@smartchat/types';
import {
  applyCall,
  barView,
  callForConversation,
  clockText,
  incomingFor,
  incomingTitle,
  isMine,
  listBadge,
  liveByConversation,
  removeCall,
  ringsForMe,
  shouldRing,
} from './call-store';

/**
 * The rules every call screen renders from, exercised as the server would drive them: the DTO
 * for each step of a call, and what the card, the bar and the list row make of it.
 */

const ME = 'member-me';
const SABBIR = 'member-sabbir';

function call(overrides: Partial<CallDto> = {}): CallDto {
  return {
    id: 'call-1',
    propertyId: 'prop-1',
    conversationId: 'conv-1',
    visitorId: 'visitor-1',
    status: 'ringing',
    answeredByMemberId: null,
    answeredByName: null,
    handledByAi: false,
    pending: null,
    visitor: { name: 'Rahim', email: 'rahim@example.com' },
    language: 'bn',
    startedAt: '2026-10-05T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    endReason: null,
    durationSeconds: 0,
    ...overrides,
  };
}

const none = new Set<string>();

describe('the map of calls', () => {
  it('follows a call from ringing through answered to ended, and lets it be dropped', () => {
    let calls = applyCall(new Map(), call());
    expect(incomingFor(calls, ME, none).map((c) => c.id)).toEqual(['call-1']);
    expect(listBadge(calls.get('call-1')!)).toBe('Ringing');

    calls = applyCall(
      calls,
      call({
        status: 'connecting',
        answeredByMemberId: ME,
        answeredByName: 'Me',
        answeredAt: '2026-10-05T10:00:05.000Z',
      }),
    );
    expect(incomingFor(calls, ME, none)).toEqual([]);
    expect(isMine(calls.get('call-1')!, ME)).toBe(true);
    expect(barView(calls.get('call-1')!, ME).label).toBe('Connecting…');

    calls = applyCall(
      calls,
      call({
        status: 'active',
        answeredByMemberId: ME,
        answeredByName: 'Me',
        answeredAt: '2026-10-05T10:00:05.000Z',
      }),
    );
    const active = barView(calls.get('call-1')!, ME);
    expect(active).toMatchObject({
      label: 'On a call',
      clock: true,
      mine: true,
      answerable: false,
      tone: 'live',
    });
    expect(listBadge(calls.get('call-1')!)).toBe('On call · Me');

    calls = applyCall(
      calls,
      call({
        status: 'ended',
        answeredByMemberId: ME,
        answeredByName: 'Me',
        answeredAt: '2026-10-05T10:00:05.000Z',
        endedAt: '2026-10-05T10:02:15.000Z',
        endReason: 'completed',
        durationSeconds: 130,
      }),
    );
    // Still on screen for its "ended" moment, and no longer a live call anywhere.
    expect(calls.get('call-1')?.status).toBe('ended');
    expect(barView(calls.get('call-1')!, ME)).toMatchObject({
      label: 'Call ended',
      tone: 'ended',
      mine: false,
    });
    expect(listBadge(calls.get('call-1')!)).toBeNull();
    expect(liveByConversation(calls).size).toBe(0);
    expect(callForConversation(calls, 'conv-1')?.status).toBe('ended');

    calls = removeCall(calls, 'call-1');
    expect(calls.size).toBe(0);
    expect(callForConversation(calls, 'conv-1')).toBeNull();
  });

  it('renders strictly from the latest DTO - a later event replaces, never merges', () => {
    let calls = applyCall(new Map(), call({ answeredByName: 'Someone' }));
    calls = applyCall(
      calls,
      call({
        status: 'active',
        handledByAi: true,
        answeredByName: 'Mira',
        answeredAt: '2026-10-05T10:00:30.000Z',
      }),
    );
    const latest = calls.get('call-1')!;
    expect(latest.answeredByName).toBe('Mira');
    expect(listBadge(latest)).toBe('AI on call');
    expect(barView(latest, ME).label).toBe('AI (Mira) is on the call');
  });

  it('ignores a call that ended before it was ever seen', () => {
    const calls = applyCall(new Map(), call({ status: 'ended', endReason: 'no_answer' }));
    expect(calls.size).toBe(0);
  });

  it('prefers the live call of a conversation over a lingering ended one', () => {
    let calls = applyCall(new Map(), call({ id: 'old' }));
    calls = applyCall(calls, call({ id: 'old', status: 'ended', endReason: 'no_answer' }));
    calls = applyCall(calls, call({ id: 'new', startedAt: '2026-10-05T10:05:00.000Z' }));
    expect(callForConversation(calls, 'conv-1')?.id).toBe('new');
  });
});

describe('who a ringing call is shown to', () => {
  it('rings everybody at the start of a call', () => {
    expect(ringsForMe(call(), ME)).toBe(true);
    expect(ringsForMe(call(), SABBIR)).toBe(true);
    // Even somebody whose own id is not known yet: the whole team was rung.
    expect(ringsForMe(call(), null)).toBe(true);
    expect(incomingTitle(call())).toBe('Incoming call');
  });

  it('shows a transfer only to the colleague it is aimed at', () => {
    const transfer = call({
      status: 'ringing',
      answeredByMemberId: SABBIR,
      answeredByName: 'Sabbir',
      answeredAt: '2026-10-05T10:00:05.000Z',
      pending: { kind: 'member', memberId: ME, name: 'Me' },
    });
    expect(ringsForMe(transfer, ME)).toBe(true);
    expect(incomingTitle(transfer)).toBe('Transfer from Sabbir');
    expect(ringsForMe(transfer, 'member-other')).toBe(false);
    // The sender is not rung by their own transfer.
    expect(ringsForMe(transfer, SABBIR)).toBe(false);
    // Unknown identity cannot be matched, so the card is not shown; the server would refuse anyway.
    expect(ringsForMe(transfer, null)).toBe(false);
    // Everybody else sees it as a transfer in progress, not as something to answer.
    expect(listBadge(transfer)).toBe('Transferring');
    expect(barView(transfer, 'member-other')).toMatchObject({
      label: 'Transferring to Me…',
      answerable: false,
      mine: false,
    });
    expect(barView(transfer, SABBIR)).toMatchObject({
      label: 'Transferring to Me…',
      answerable: false,
      mine: true,
    });
    expect(barView(transfer, ME)).toMatchObject({
      label: 'Transfer from Sabbir',
      answerable: true,
      mine: false,
      tone: 'ringing',
    });
  });

  it('never rings anybody for a transfer to the AI', () => {
    const toAi = call({
      status: 'ringing',
      answeredByMemberId: SABBIR,
      answeredByName: 'Sabbir',
      pending: { kind: 'ai' },
    });
    expect(ringsForMe(toAi, ME)).toBe(false);
    expect(barView(toAi, ME).label).toBe('Transferring to the AI assistant…');
  });

  it('rings the team when the AI asks for a person, and says so', () => {
    const askingForPerson = call({
      status: 'ringing',
      handledByAi: true,
      answeredByName: 'Mira',
      answeredAt: '2026-10-05T10:00:30.000Z',
    });
    expect(ringsForMe(askingForPerson, ME)).toBe(true);
    expect(incomingTitle(askingForPerson)).toBe('Mira is asking for a person');
    expect(barView(askingForPerson, ME)).toMatchObject({
      label: 'Mira is asking for a person · ringing the team…',
      answerable: true,
    });
  });

  it('orders the cards by who has waited longest', () => {
    let calls = applyCall(new Map(), call({ id: 'later', startedAt: '2026-10-05T10:00:10.000Z' }));
    calls = applyCall(calls, call({ id: 'earlier', startedAt: '2026-10-05T10:00:00.000Z' }));
    expect(incomingFor(calls, ME, none).map((c) => c.id)).toEqual(['earlier', 'later']);
  });
});

describe('a call somebody else took first', () => {
  it('leaves the card once dismissed, and shows who has it as soon as the DTO says', () => {
    let calls = applyCall(new Map(), call());
    const dismissed = new Set(['call-1']);
    expect(incomingFor(calls, ME, dismissed)).toEqual([]);

    calls = applyCall(
      calls,
      call({
        status: 'connecting',
        answeredByMemberId: SABBIR,
        answeredByName: 'Sabbir Ahmed',
        answeredAt: '2026-10-05T10:00:05.000Z',
      }),
    );
    expect(ringsForMe(calls.get('call-1')!, ME)).toBe(false);
    expect(isMine(calls.get('call-1')!, ME)).toBe(false);
    expect(barView(calls.get('call-1')!, ME)).toMatchObject({
      label: 'Sabbir Ahmed is connecting…',
      mine: false,
      answerable: false,
    });
    expect(listBadge(calls.get('call-1')!)).toBe('On call · Sabbir');

    calls = applyCall(
      calls,
      call({
        status: 'active',
        answeredByMemberId: SABBIR,
        answeredByName: 'Sabbir Ahmed',
        answeredAt: '2026-10-05T10:00:05.000Z',
      }),
    );
    expect(barView(calls.get('call-1')!, ME)).toMatchObject({
      label: 'On a call · Sabbir Ahmed',
      clock: true,
      mine: false,
    });
  });
});

describe('the small things', () => {
  it('formats the clock', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(102)).toBe('1:42');
    expect(clockText(3_601.8)).toBe('60:01');
  });

  it('rings only while something rings for me, sound is on, and I am not already talking', () => {
    expect(shouldRing({ incoming: 1, soundOn: true, onCall: false })).toBe(true);
    expect(shouldRing({ incoming: 0, soundOn: true, onCall: false })).toBe(false);
    expect(shouldRing({ incoming: 1, soundOn: false, onCall: false })).toBe(false);
    expect(shouldRing({ incoming: 2, soundOn: true, onCall: true })).toBe(false);
  });

  it('calls a missed call missed', () => {
    expect(barView(call({ status: 'ended', endReason: 'no_answer' }), ME)).toMatchObject({
      label: 'Missed call',
      tone: 'ended',
    });
  });
});
