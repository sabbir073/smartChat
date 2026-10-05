import type { CallDto, VoiceLanguage } from '@smartchat/types';
import type { CallRoom, CallRoomFactory, RoomLossReason } from './call-room.js';
import {
  BAR_LINGER_MS,
  IDLE,
  MICROPHONE_NEEDED_TEXT,
  formatClock,
  isResumable,
  reduceCall,
  ringbackFor,
  startFailureText,
  type CallAction,
  type CallPhase,
} from './call-state.js';
import type { Ringback } from './ringback.js';

/**
 * Everything a call needs from the outside world, so a test can hand in fakes.
 *
 * The API here is the widget's call endpoints, the room is the `CallRoom` interface, the ringback
 * is the two-tone generator, and the timers are the window's unless a test says otherwise.
 */
export interface CallApi {
  start(input: { preChat?: Record<string, string>; language?: VoiceLanguage }): Promise<{
    call: CallDto;
    join: { url: string; token: string } | null;
  }>;
  current(): Promise<{ call: CallDto; join: { url: string; token: string } } | null>;
  get(callId: string): Promise<CallDto>;
  joined(callId: string): Promise<CallDto>;
  end(callId: string): Promise<CallDto>;
}

export interface CallControllerDeps {
  api: CallApi;
  createRoom: CallRoomFactory;
  ringback: Ringback;
  requestMicrophone: () => Promise<boolean>;
  /** The language to ask the AI to greet in; nothing means the website's default. */
  language?: VoiceLanguage | undefined;
  timers?: {
    setTimeout(handler: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
  now?: () => number;
}

/** What the bar renders from. Replaced whole on every change, never mutated. */
export interface CallSnapshot {
  phase: CallPhase;
  /** The browser will not play the other side until the visitor taps something. */
  audioBlocked: boolean;
  /** A hang-up is on its way to the server; the buttons wait for the answer. */
  hangingUp: boolean;
}

/** An API failure as the controller reads it; the shape `WidgetApiError` has. */
function asApiError(error: unknown): { code: string; status: number } | null {
  if (error && typeof error === 'object' && 'code' in error && 'status' in error) {
    const { code, status } = error as { code: unknown; status: unknown };
    if (typeof code === 'string' && typeof status === 'number') return { code, status };
  }
  return null;
}

export class CallController {
  private snapshot: CallSnapshot = { phase: IDLE, audioBlocked: false, hangingUp: false };
  private room: CallRoom | null = null;
  private lingerTimer: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly timers: NonNullable<CallControllerDeps['timers']>;
  private readonly now: () => number;

  constructor(private readonly deps: CallControllerDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (handler, ms) => window.setTimeout(handler, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    };
    this.now = deps.now ?? (() => Date.now());
  }

  // --- the store, for useSyncExternalStore ------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot => this.snapshot;

  get phase(): CallPhase {
    return this.snapshot.phase;
  }

  /**
   * The phase as it is right now, for a check after an `await`.
   *
   * A method rather than the getter, because TypeScript narrows a property it has compared
   * once and keeps that narrowing across the await that may have changed it; a call result is
   * never narrowed.
   */
  private kind(): CallPhase['kind'] {
    return this.snapshot.phase.kind;
  }

  // --- what the panel asks for --------------------------------------------------

  /**
   * The visitor pressed Call.
   *
   * In this order on purpose: the microphone is settled before anything rings, the media client
   * is loaded before the server is asked (a chunk that fails to download must not ring the team
   * for a call that cannot be heard), and only then is the call started. The ringback is primed
   * synchronously, while the tap still counts as a gesture.
   */
  async startCall(preChat?: Record<string, string>): Promise<void> {
    if (this.phase.kind === 'starting' || this.phase.kind === 'live') return;
    this.deps.ringback.prime();
    this.dispatch({ type: 'start' });

    if (!(await this.deps.requestMicrophone())) {
      this.dispatch({ type: 'failed', text: MICROPHONE_NEEDED_TEXT });
      return;
    }
    if (this.kind() !== 'starting') return;

    let room: CallRoom;
    try {
      room = await this.openRoom();
    } catch {
      this.dispatch({ type: 'failed', text: startFailureText(null) });
      return;
    }
    if (this.kind() !== 'starting') {
      await this.closeRoom(room);
      return;
    }

    let started: Awaited<ReturnType<CallApi['start']>>;
    try {
      started = await this.deps.api.start({
        ...(preChat ? { preChat } : {}),
        ...(this.deps.language ? { language: this.deps.language } : {}),
      });
    } catch (error) {
      await this.closeRoom(room);
      this.dispatch({ type: 'failed', text: startFailureText(asApiError(error)) });
      return;
    }

    this.dispatch({ type: 'started', call: started.call });
    if (this.kind() !== 'live') {
      await this.closeRoom(room);
      return;
    }
    if (!started.join) {
      // The contract says this only happens with a call that already ended; a live call with
      // no key would be a call nobody can hear, so it is ended rather than left ringing.
      await this.closeRoom(room);
      this.lost(started.call.id, 'The call could not be connected');
      return;
    }
    this.room = room;
    await this.join(room, started.join, started.call.id);
  }

  /**
   * Pick up a call that is already going - the panel was reloaded in the middle of one.
   *
   * Asked once, on load. The server hands over a fresh key for the room along with the call, so
   * the panel rejoins without the visitor pressing anything; the ringing, if it is still ringing,
   * starts again from here.
   */
  async resume(): Promise<void> {
    if (this.phase.kind !== 'idle' && this.phase.kind !== 'over') return;
    let current: Awaited<ReturnType<CallApi['current']>>;
    try {
      current = await this.deps.api.current();
    } catch {
      return;
    }
    if (!isResumable(current)) return;
    if (this.kind() !== 'idle' && this.kind() !== 'over') return;

    this.dispatch({ type: 'resumed', call: current.call });
    if (this.kind() !== 'live') return;
    let room: CallRoom;
    try {
      room = await this.openRoom();
    } catch {
      this.lost(current.call.id, 'The call could not be reconnected');
      return;
    }
    if (this.kind() !== 'live') {
      await this.closeRoom(room);
      return;
    }
    this.room = room;
    await this.join(room, current.join, current.call.id);
  }

  /**
   * `call:updated` arrived. The DTO is the truth; the phase follows it.
   *
   * A live call this panel never started is left alone rather than joined: it is the visitor's
   * call in another tab, and joining it from here with the same identity would throw that tab
   * out of its own call.
   */
  onServerUpdate(call: CallDto): void {
    this.dispatch({ type: 'updated', call });
  }

  async hangUp(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'live' || this.snapshot.hangingUp) return;
    this.publish({ ...this.snapshot, hangingUp: true });
    try {
      const ended = await this.deps.api.end(phase.call.id);
      this.dispatch({ type: 'updated', call: ended });
    } catch {
      // The server could not be told. The room goes anyway; the media server will tell it.
      this.dispatch({ type: 'ended_locally', text: locallyEndedText(phase.call, this.now()) });
    } finally {
      if (this.snapshot.hangingUp) this.publish({ ...this.snapshot, hangingUp: false });
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.phase.kind !== 'live' || !this.room) return;
    try {
      await this.room.setMicrophoneEnabled(!muted);
      this.dispatch({ type: 'muted', muted });
    } catch {
      // The track could not be changed; the button stays as it was, which is the truth.
    }
  }

  /** The visitor tapped "Tap to hear": a gesture, which is what the browser was waiting for. */
  async unblockAudio(): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.startAudio();
      this.publish({ ...this.snapshot, audioBlocked: false });
    } catch {
      /* still blocked; the button stays */
    }
  }

  /**
   * The panel is going away: silence, and leave the room.
   *
   * Everything is reset rather than marked dead, because React's development mode mounts a
   * component, unmounts it and mounts it again, and the second mount must find a controller
   * that still works. Whatever was on the server side ends when the media server sees us leave.
   */
  dispose(): void {
    this.deps.ringback.stop();
    if (this.lingerTimer !== null) {
      this.timers.clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    const room = this.room;
    this.room = null;
    if (room) void room.disconnect().catch(() => undefined);
    this.publish({ phase: IDLE, audioBlocked: false, hangingUp: false });
  }

  // --- the room -------------------------------------------------------------------

  private openRoom(): Promise<CallRoom> {
    return this.deps.createRoom({
      onDisconnected: (reason) => void this.onRoomDisconnected(reason),
      onAudioBlocked: (blocked) => this.publish({ ...this.snapshot, audioBlocked: blocked }),
    });
  }

  private async closeRoom(room: CallRoom): Promise<void> {
    if (this.room === room) this.room = null;
    try {
      await room.disconnect();
    } catch {
      /* it was never up */
    }
  }

  /** Connect, publish the microphone, tell the server. Any failure ends the call honestly. */
  private async join(
    room: CallRoom,
    grant: { url: string; token: string },
    callId: string,
  ): Promise<void> {
    try {
      await room.connect(grant.url, grant.token);
    } catch {
      this.lost(callId, 'The call could not be connected');
      return;
    }
    if (this.room !== room) return;
    try {
      await room.setMicrophoneEnabled(true);
    } catch {
      this.lost(callId, MICROPHONE_NEEDED_TEXT);
      return;
    }
    if (this.room !== room) return;
    // Playback usually starts on its own after the microphone prompt; if the browser disagrees
    // it says so through the audio status event, and the bar offers a tap.
    void room.startAudio().catch(() => undefined);
    this.dispatch({ type: 'joined' });
    try {
      const dto = await this.deps.api.joined(callId);
      // Only the end of a call is taken from this answer: the socket carries every other change,
      // and a response that overtook an event must not wind the bar back.
      if (dto.status === 'ended') this.dispatch({ type: 'updated', call: dto });
    } catch {
      /* the media server's webhook reports the arrival too */
    }
  }

  /**
   * The room went away under a live call.
   *
   * When the media server closed it the call has almost certainly just ended and the socket's
   * word is on its way; the server is asked rather than assumed, because the two can arrive in
   * either order. When the visitor took the call to another tab, this tab bows out and leaves
   * the call alone. When the network dropped, the call is over for this visitor whatever the
   * server thinks, so it is ended.
   */
  private async onRoomDisconnected(reason: RoomLossReason): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'live') return;
    const callId = phase.call.id;
    if (reason === 'elsewhere') {
      this.dispatch({ type: 'ended_locally', text: 'This call continues in another tab' });
      return;
    }
    if (reason === 'closed') {
      try {
        const dto = await this.deps.api.get(callId);
        if (dto.status === 'ended') {
          this.dispatch({ type: 'updated', call: dto });
          return;
        }
      } catch {
        /* fall through: treat it as a loss */
      }
      if (this.kind() !== 'live') return;
    }
    this.lost(callId, 'Connection lost');
  }

  /** Mark the room lost and end the call on the server; the bar keeps `text` as its last word. */
  private lost(callId: string, text: string): void {
    if (this.phase.kind !== 'live' || this.phase.call.id !== callId) return;
    this.dispatch({ type: 'lost', text });
    void this.deps.api
      .end(callId)
      .then((ended) => this.dispatch({ type: 'updated', call: ended }))
      .catch(() => this.dispatch({ type: 'ended_locally', text }));
  }

  // --- state -----------------------------------------------------------------------

  private dispatch(action: CallAction): void {
    const before = this.phase;
    const after = reduceCall(before, action);
    if (after === before) return;
    this.publish({ ...this.snapshot, phase: after });
    this.afterChange(before, after);
  }

  private afterChange(before: CallPhase, after: CallPhase): void {
    const ringback = ringbackFor(before, after);
    if (ringback === 'start') this.deps.ringback.start();
    if (ringback === 'stop') this.deps.ringback.stop();

    if (after.kind === 'over' && before.kind !== 'over') {
      if (this.lingerTimer !== null) this.timers.clearTimeout(this.lingerTimer);
      this.lingerTimer = this.timers.setTimeout(() => {
        this.lingerTimer = null;
        this.dispatch({ type: 'linger_over' });
      }, BAR_LINGER_MS);
    }
    if (
      before.kind === 'over' &&
      after.kind !== 'over' &&
      after.kind !== 'idle' &&
      this.lingerTimer !== null
    ) {
      this.timers.clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }

    // No call on screen means no room: whatever ended it, the audio stops now.
    if (after.kind !== 'live' && after.kind !== 'starting' && this.room) {
      const room = this.room;
      this.room = null;
      void room.disconnect().catch(() => undefined);
      if (this.snapshot.audioBlocked) this.publish({ ...this.snapshot, audioBlocked: false });
    }
  }

  private publish(next: CallSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** The bar's last line when the visitor hung up and the server could not be told. */
function locallyEndedText(call: CallDto, nowMs: number): string {
  if (!call.answeredAt) return 'Call cancelled';
  const answered = Date.parse(call.answeredAt);
  const seconds = Number.isNaN(answered) ? 0 : Math.max(0, Math.floor((nowMs - answered) / 1000));
  return `Call ended · ${formatClock(seconds)}`;
}
