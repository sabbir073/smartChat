import type { CallDto } from '@smartchat/types';

/**
 * The dashboard's picture of every live call, and the rules for what each screen shows.
 *
 * Pure functions over a map keyed by call id. The provider feeds the map from the socket and from
 * the initial fetch; nothing here remembers anything, which is what makes the rules testable
 * without a browser and the same wherever they are used - the ringing card, the thread bar and
 * the list badge cannot disagree about whose call it is.
 *
 * One rule shapes everything: render strictly from the latest DTO. The server sends the whole
 * call on every change, so a screen that missed one event is right again on the next, and nothing
 * here guesses at a transition it did not see.
 */

export type CallMap = ReadonlyMap<string, CallDto>;

/** A new map with this call in it. The latest DTO wins; there is no merging. */
export function applyCall(calls: CallMap, call: CallDto): Map<string, CallDto> {
  const next = new Map(calls);
  // A call that ended before this dashboard ever saw it is history, and the conversation's own
  // system message already tells it. Only a call that was on screen gets its "ended" moment.
  if (call.status === 'ended' && !calls.has(call.id)) return next;
  next.set(call.id, call);
  return next;
}

export function removeCall(calls: CallMap, callId: string): Map<string, CallDto> {
  if (!calls.has(callId)) return new Map(calls);
  const next = new Map(calls);
  next.delete(callId);
  return next;
}

export function isLive(call: CallDto): boolean {
  return call.status !== 'ended';
}

/**
 * Whether this call is ringing *for me*.
 *
 * The whole team rings at the start of a call and when the AI asks for a person - those have no
 * pending target. A transfer rings exactly one colleague: it is shown to them and to nobody else,
 * because a card that says "Answer" to a person the server will refuse is worse than no card.
 * While my own identity is unknown a transfer cannot be matched, so it is not shown; the server
 * would refuse the answer anyway.
 */
export function ringsForMe(call: CallDto, me: string | null): boolean {
  if (call.status !== 'ringing') return false;
  if (call.pending === null)
    return call.answeredByMemberId === null || call.answeredByMemberId !== me;
  if (call.pending.kind === 'ai') return false;
  return me !== null && call.pending.memberId === me;
}

/** The calls to show as cards, oldest first so the one that has waited longest is nearest the hand. */
export function incomingFor(
  calls: CallMap,
  me: string | null,
  dismissed: ReadonlySet<string>,
): CallDto[] {
  return [...calls.values()]
    .filter((call) => ringsForMe(call, me) && !dismissed.has(call.id))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Whether I am the person holding this call. */
export function isMine(call: CallDto, me: string | null): boolean {
  return me !== null && !call.handledByAi && call.answeredByMemberId === me;
}

/**
 * The call a conversation is on, if any. Live ones first; an ended one only while it is still on
 * screen, so the bar can say "Call ended" before it goes.
 */
export function callForConversation(calls: CallMap, conversationId: string): CallDto | null {
  let ended: CallDto | null = null;
  for (const call of calls.values()) {
    if (call.conversationId !== conversationId) continue;
    if (isLive(call)) return call;
    ended = call;
  }
  return ended;
}

/** Every live call, keyed by conversation, for the list to badge its rows from. */
export function liveByConversation(calls: CallMap): Map<string, CallDto> {
  const out = new Map<string, CallDto>();
  for (const call of calls.values()) if (isLive(call)) out.set(call.conversationId, call);
  return out;
}

/** The short label on a list row: where the call is, in two words. Null when there is nothing to say. */
export function listBadge(call: CallDto): string | null {
  switch (call.status) {
    case 'ringing':
      if (call.pending) return 'Transferring';
      return call.queuedAt ? 'Holding' : 'Ringing';
    case 'connecting':
    case 'active':
      if (call.handledByAi) return 'AI on call';
      return call.answeredByName ? `On call · ${firstName(call.answeredByName)}` : 'On call';
    case 'ended':
      return null;
  }
}

/** The ringing card's heading: a fresh call, or a colleague handing one over. */
export function incomingTitle(call: CallDto): string {
  if (call.pending?.kind === 'member') {
    return call.answeredByName ? `Transfer from ${call.answeredByName}` : 'Transferred call';
  }
  if (call.handledByAi)
    return call.answeredByName
      ? `${call.answeredByName} is asking for a person`
      : 'The AI is asking for a person';
  // Nobody answered and the AI is on other calls: the caller is still holding, alone.
  if (call.queuedAt) return 'Caller holding · the AI is busy';
  return 'Incoming call';
}

/** The visitor as the card and the bar name them. */
export function callerLabel(call: CallDto): string {
  return call.visitor.name ?? call.visitor.email ?? 'Visitor';
}

export interface BarView {
  /** What the bar says, without the running clock; the clock is appended by the screen. */
  label: string;
  /** Whether a running clock from `answeredAt` belongs after the label. */
  clock: boolean;
  /** I hold this call: mute, transfer and hang up apply. */
  mine: boolean;
  /** It rings for me: an Answer button belongs in the bar. */
  answerable: boolean;
  tone: 'ringing' | 'live' | 'ai' | 'ended';
}

/**
 * The thread bar, from the DTO and who I am. One function so the bar, like the card, is a pure
 * rendering of the call rather than a second state machine.
 */
export function barView(call: CallDto, me: string | null): BarView {
  const mine = isMine(call, me);
  switch (call.status) {
    case 'ringing': {
      if (call.pending?.kind === 'member') {
        const target = me !== null && call.pending.memberId === me;
        return {
          label: target
            ? incomingTitle(call)
            : `Transferring to ${call.pending.name ?? 'a colleague'}…`,
          clock: false,
          mine: mine && !target,
          answerable: target,
          tone: 'ringing',
        };
      }
      if (call.pending?.kind === 'ai') {
        return {
          label: 'Transferring to the AI assistant…',
          clock: false,
          mine,
          answerable: false,
          tone: 'ringing',
        };
      }
      return {
        label: call.handledByAi
          ? `${call.answeredByName ?? 'The AI'} is asking for a person · ringing the team…`
          : call.queuedAt
            ? 'Holding for the AI, which is on other calls · answer to take it'
            : 'Ringing the team…',
        clock: false,
        mine: false,
        answerable: ringsForMe(call, me),
        tone: 'ringing',
      };
    }
    case 'connecting':
      if (call.handledByAi)
        return {
          label: `${call.answeredByName ?? 'The AI'} is joining…`,
          clock: false,
          mine: false,
          answerable: false,
          tone: 'ai',
        };
      return {
        label: mine ? 'Connecting…' : `${call.answeredByName ?? 'A colleague'} is connecting…`,
        clock: false,
        mine,
        answerable: false,
        tone: 'live',
      };
    case 'active':
      if (call.handledByAi)
        return {
          label: `AI (${call.answeredByName ?? 'assistant'}) is on the call`,
          clock: true,
          mine: false,
          answerable: false,
          tone: 'ai',
        };
      return {
        label: mine ? 'On a call' : `On a call · ${call.answeredByName ?? 'a colleague'}`,
        clock: true,
        mine,
        answerable: false,
        tone: 'live',
      };
    case 'ended':
      return {
        label: call.answeredAt ? 'Call ended' : 'Missed call',
        clock: false,
        mine: false,
        answerable: false,
        tone: 'ended',
      };
  }
}

/** "1:42", the running clock on a live call. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** Seconds since the call was answered, for the clock. Zero before it was. */
export function secondsOnCall(call: CallDto, now: number): number {
  if (!call.answeredAt) return 0;
  return Math.max(0, (now - new Date(call.answeredAt).getTime()) / 1000);
}

/**
 * Whether the ring tone should be sounding.
 *
 * It rings while something rings for me and this browser wants sound. Not while I am already
 * on a call: a ring over a conversation is unanswerable noise, and the card still shows.
 */
export function shouldRing(input: {
  incoming: number;
  soundOn: boolean;
  onCall: boolean;
}): boolean {
  return input.incoming > 0 && input.soundOn && !input.onCall;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
