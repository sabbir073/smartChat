import type { CallDto, VoiceLanguage } from '@smartchat/types';

/**
 * The call bar's state, as pure data.
 *
 * Everything the bar shows is derived from the latest `CallDto` the server sent plus three local
 * facts the server cannot know: whether the microphone is muted, whether the media room is up,
 * and whether a failure happened before there was a call at all. The reducer below is the only
 * place a transition is decided, so the rules can be tested without a browser, a socket or a
 * media server.
 */

/** How long the bar stays after a call is over, so the visitor can read why it ended. */
export const BAR_LINGER_MS = 6000;

/** Where the panel stands with the media room. The server's `status` says where the call is. */
export type RoomState = 'joining' | 'joined' | 'lost';

export type CallPhase =
  | { kind: 'idle' }
  /** Call was pressed: the microphone is being asked for, the server has not answered yet. */
  | { kind: 'starting' }
  | {
      kind: 'live';
      call: CallDto;
      muted: boolean;
      room: RoomState;
      /** Why the room is lost, in the visitor's words; the bar's last line once the call ends. */
      lostText: string | null;
    }
  /** Over, for whatever reason. `call` is null when it never got as far as the server. */
  | { kind: 'over'; call: CallDto | null; text: string };

export type CallAction =
  | { type: 'start' }
  /** `POST /widget/calls` answered. */
  | { type: 'started'; call: CallDto }
  /** `GET /widget/calls/current` found a live call after a reload. */
  | { type: 'resumed'; call: CallDto }
  /** `call:updated` from the socket, or any later DTO from the API. */
  | { type: 'updated'; call: CallDto }
  /** The media room is up: connected, microphone published. */
  | { type: 'joined' }
  /** The media room is gone and the call is being ended; `text` is what the visitor is told. */
  | { type: 'lost'; text: string }
  | { type: 'muted'; muted: boolean }
  /** Nothing to show but a sentence: the microphone was refused, the server said no. */
  | { type: 'failed'; text: string }
  /** The visitor hung up but the server could not be told; the bar ends the call on its own. */
  | { type: 'ended_locally'; text: string }
  /** The six seconds are up. */
  | { type: 'linger_over' };

export const IDLE: CallPhase = { kind: 'idle' };

export function reduceCall(phase: CallPhase, action: CallAction): CallPhase {
  switch (action.type) {
    case 'start':
      // Pressing Call twice is one call.
      if (phase.kind === 'starting' || phase.kind === 'live') return phase;
      return { kind: 'starting' };

    case 'started':
    case 'resumed':
    case 'updated':
      return applyDto(phase, action.call, action.type);

    case 'joined':
      return phase.kind === 'live' && phase.room === 'joining'
        ? { ...phase, room: 'joined' }
        : phase;

    case 'lost':
      return phase.kind === 'live' && phase.room !== 'lost'
        ? { ...phase, room: 'lost', lostText: action.text }
        : phase;

    case 'muted':
      return phase.kind === 'live' ? { ...phase, muted: action.muted } : phase;

    case 'failed':
      return { kind: 'over', call: null, text: action.text };

    case 'ended_locally':
      return phase.kind === 'live' ? { kind: 'over', call: phase.call, text: action.text } : phase;

    case 'linger_over':
      return phase.kind === 'over' ? IDLE : phase;

    default:
      return phase;
  }
}

/**
 * Fold a DTO into the phase.
 *
 * The socket's picture is the freshest: once it has delivered a DTO for a call, the HTTP
 * response that started that call is stale by definition, so `started` and `resumed` are only
 * applied while nothing has arrived yet. An ended DTO is applied whatever its source - a call
 * must never be shown live after the server has said it is over.
 */
function applyDto(
  phase: CallPhase,
  call: CallDto,
  source: 'started' | 'resumed' | 'updated',
): CallPhase {
  if (call.status === 'ended') {
    if (phase.kind === 'live' && phase.call.id === call.id) {
      // A call that ended because this side lost the room is reported as that, not as a
      // tidy "Call ended": the visitor was cut off, and the bar should say so.
      return { kind: 'over', call, text: phase.lostText ?? endedText(call) };
    }
    if (phase.kind === 'starting' && source !== 'updated') {
      // Missed on the spot: nobody to ring, no AI to take it.
      return { kind: 'over', call, text: endedText(call) };
    }
    // Over already, or a call this panel never showed: nothing to say about it.
    return phase;
  }

  if (phase.kind === 'live') {
    // A different live call while this one is on screen can only be a stale event: the server
    // gives a visitor one call at a time, and a second Call press returns the same one.
    if (phase.call.id !== call.id) return phase;
    if (source !== 'updated') return phase;
    return { ...phase, call };
  }

  if (phase.kind === 'over' && phase.call?.id === call.id) {
    // The bar already said this call ended; a late "ringing" cannot bring it back.
    return phase;
  }

  // `updated` while idle or over is a live call this panel never started: the visitor's call in
  // another tab. It is left alone - joining it from here would take it away from that tab.
  if (source === 'updated' && phase.kind !== 'starting') return phase;

  return { kind: 'live', call, muted: false, room: 'joining', lostText: null };
}

/** The call on screen, whichever phase it is in. */
export function callOf(phase: CallPhase): CallDto | null {
  return phase.kind === 'live' || phase.kind === 'over' ? phase.call : null;
}

/**
 * Whether the visitor should hear ringing.
 *
 * Only while the team is being rung for a call nobody has picked up yet. During a transfer the
 * status is `ringing` too, but the visitor is still talking to the person who is transferring
 * them - a ringback over that conversation would be absurd.
 */
export function wantsRingback(phase: CallPhase): boolean {
  return (
    phase.kind === 'live' &&
    phase.room !== 'lost' &&
    phase.call.status === 'ringing' &&
    phase.call.answeredAt === null
  );
}

export type RingbackDecision = 'start' | 'stop' | 'keep';

export function ringbackFor(before: CallPhase, after: CallPhase): RingbackDecision {
  const was = wantsRingback(before);
  const is = wantsRingback(after);
  if (!was && is) return 'start';
  if (was && !is) return 'stop';
  return 'keep';
}

/**
 * Whether the pre-chat form must be filled in before a call can start.
 *
 * The same rule, with the same inputs, as the one that puts the form in front of a visitor's
 * first message: the customer asked for details before a conversation opens, and a call opens
 * one. Changing one of these without the other would mean a visitor could skip the form by
 * calling instead of typing.
 */
export function needsDetailsBeforeCalling(input: {
  preChatEnabled: boolean;
  /** Answers already collected this session, waiting to travel with the first message or call. */
  hasPreChat: boolean;
  /** The server already knows a name or an email for this visitor. */
  knowsVisitor: boolean;
  /** The visitor has written something in this conversation; the form's moment has passed. */
  hasVisitorMessages: boolean;
  preview: boolean;
}): boolean {
  return (
    input.preChatEnabled &&
    !input.hasPreChat &&
    !input.knowsVisitor &&
    !input.hasVisitorMessages &&
    !input.preview
  );
}

/** Whether what `GET /widget/calls/current` returned is a call worth rejoining. */
export function isResumable(
  current: { call: CallDto } | null | undefined,
): current is { call: CallDto } {
  return current !== null && current !== undefined && current.call.status !== 'ended';
}

/**
 * Which language to ask the AI to greet in.
 *
 * Bengali only when the browser says so; otherwise nothing, so the website's own default
 * applies. Sending `en` for every other browser would override a Bengali-speaking business's
 * choice for visitors whose browsers happen to be in English, which is most of them.
 */
export function languageHint(browserLanguage: string | undefined): VoiceLanguage | undefined {
  return typeof browserLanguage === 'string' && /^bn\b/i.test(browserLanguage) ? 'bn' : undefined;
}

// --- wording -----------------------------------------------------------------

/** Seconds as a clock: 0:07, 1:42, 1:02:05. For the live timer and the bar's final line. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

/** Seconds in words: 45 s, 2 min 10 s, 1 h 2 min. For the line in the transcript. */
export function describeDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** How long the call has been answered for, for the live timer. Zero until it is answered. */
export function elapsedSeconds(answeredAt: string | null, nowMs: number): number {
  if (!answeredAt) return 0;
  const answered = Date.parse(answeredAt);
  if (Number.isNaN(answered)) return 0;
  return Math.max(0, Math.floor((nowMs - answered) / 1000));
}

/** The bar's final line for a call the server has ended. */
export function endedText(call: CallDto): string {
  switch (call.endReason) {
    case 'no_answer':
      return 'Nobody is available right now — leave a message below';
    case 'cancelled':
      return 'Call cancelled';
    case 'failed':
      return 'The call could not be connected';
    case 'allowance':
      return call.answeredAt
        ? `Call ended · ${formatClock(call.durationSeconds)} · Call minutes used up`
        : 'Call minutes used up';
    default:
      return call.answeredAt ? `Call ended · ${formatClock(call.durationSeconds)}` : 'Missed call';
  }
}

/** What the bar says while a call is on, before the timer. */
export function liveText(phase: Extract<CallPhase, { kind: 'live' }>): string {
  const { call, room } = phase;
  if (room === 'lost') return phase.lostText ?? 'Connection lost';
  if (call.pending) {
    const target =
      call.pending.kind === 'member'
        ? (call.pending.name ?? 'a colleague')
        : (call.answeredByName ?? 'the AI assistant');
    return `Transferring to ${target}…`;
  }
  switch (call.status) {
    case 'ringing':
      // Rung on the visitor's behalf by the assistant, who keeps talking meanwhile.
      return call.answeredAt ? 'Finding someone for you…' : 'Calling…';
    case 'connecting':
      return 'Connecting…';
    case 'active':
      return call.handledByAi
        ? `Talking to ${call.answeredByName ?? 'the AI assistant'}`
        : `On a call with ${call.answeredByName ?? 'the support team'}`;
    default:
      return 'Connecting…';
  }
}

/** The bar's line for a call that could not start. */
export function startFailureText(error: { code: string; status: number } | null): string {
  if (!error) return 'We could not start the call. Please try again.';
  switch (error.code) {
    case 'PLAN_LIMIT_REACHED':
      return 'Call minutes used up';
    case 'FEATURE_NOT_IN_PLAN':
    case 'FEATURE_NOT_AVAILABLE':
      return 'Calling is not available on this website';
    case 'RATE_LIMITED':
      return 'Too many calls. Please try again in a moment.';
    default:
      return error.status === 0
        ? 'We could not reach the call service. Please try again.'
        : 'We could not start the call. Please try again.';
  }
}

export const MICROPHONE_NEEDED_TEXT = 'Microphone access is needed to call';
