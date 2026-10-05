import {
  AudioFrame,
  AudioSource,
  AudioStream,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { Emitter } from './emitter.js';
import { STT_SAMPLE_RATE, TTS_SAMPLE_RATE, int16ToBytes } from './pcm.js';
import type { AudioSink } from './speaker.js';

/**
 * The media room, as the AI sees it: one visitor to listen to, one microphone to speak with.
 *
 * Identities tell the parties apart without a lookup (`visitor:`, `member:`, `ai:`), and only
 * the visitor's audio is ever read. A team member's voice during a hand-over is not the AI's to
 * transcribe, and - the part that matters for the ears - the AI's own voice never reaches the
 * speech service: the only track it listens to is the visitor's, so there is no echo path and
 * nothing to mute while it talks.
 */

export interface CallRoomEvents extends Record<string, unknown> {
  /** The visitor's microphone, subscribed. Fires again if it is re-published after a reconnect. */
  visitor_track: RemoteTrack;
  visitor_left: undefined;
  /** We are out of the room: removed, the room closed, or the connection died. */
  disconnected: { reason: string };
}

export interface CallRoomOptions {
  url: string;
  token: string;
  log: (event: string, detail: Record<string, unknown>) => void;
}

/** Why the room could not be used, in a form the session can act on. */
export class RoomError extends Error {
  constructor(
    public readonly code: 'timeout' | 'visitor_left' | 'disconnected',
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/** What the session needs from a room; `CallRoom` is the real one, a test supplies a fake. */
export interface CallRoomLike {
  readonly events: Emitter<CallRoomEvents>;
  connect(): Promise<void>;
  publishVoice(): Promise<AudioSink>;
  waitForVisitorTrack(timeoutMs: number): Promise<RemoteTrack>;
  pump(
    track: RemoteTrack,
    onBytes: (bytes: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void>;
  leave(): Promise<void>;
}

export function isVisitor(participant: RemoteParticipant): boolean {
  return participant.identity.startsWith('visitor:');
}

export class CallRoom implements CallRoomLike {
  readonly events = new Emitter<CallRoomEvents>();
  private readonly room = new Room();
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private visitorTrack: RemoteTrack | null = null;
  private left = false;

  constructor(private readonly options: CallRoomOptions) {}

  get connected(): boolean {
    return this.room.isConnected;
  }

  async connect(): Promise<void> {
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (!isVisitor(participant) || track.kind !== TrackKind.KIND_AUDIO) return;
      this.visitorTrack = track;
      this.events.emit('visitor_track', track);
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (isVisitor(participant)) this.events.emit('visitor_left', undefined);
    });
    this.room.on(RoomEvent.Disconnected, (reason) => {
      this.events.emit('disconnected', { reason: DisconnectReason[reason] ?? String(reason) });
    });
    await this.room.connect(this.options.url, this.options.token, {
      autoSubscribe: true,
      dynacast: false,
    });
    // The visitor is usually in the room before the AI: their track is already subscribed and
    // no event will announce it, so it is looked for by hand once.
    for (const participant of this.room.remoteParticipants.values()) {
      if (!isVisitor(participant)) continue;
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (track && track.kind === TrackKind.KIND_AUDIO) {
          this.visitorTrack = track as RemoteTrack;
          this.events.emit('visitor_track', track as RemoteTrack);
        }
      }
    }
  }

  /** The visitor's audio track, now or within the timeout. Rejects with a RoomError. */
  waitForVisitorTrack(timeoutMs: number): Promise<RemoteTrack> {
    if (this.visitorTrack) return Promise.resolve(this.visitorTrack);
    return new Promise<RemoteTrack>((resolve, reject) => {
      const offs: Array<() => void> = [];
      const done = (): void => {
        clearTimeout(timer);
        for (const off of offs) off();
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new RoomError('timeout', `the visitor's audio did not arrive within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      offs.push(
        this.events.on('visitor_track', (track) => {
          done();
          resolve(track);
        }),
        this.events.on('visitor_left', () => {
          done();
          reject(new RoomError('visitor_left', 'the visitor left before the AI could hear them'));
        }),
        this.events.on('disconnected', ({ reason }) => {
          done();
          reject(
            new RoomError(
              'disconnected',
              `out of the room while waiting for the visitor (${reason})`,
            ),
          );
        }),
      );
    });
  }

  /** Publish the AI's microphone and return the sink the speaker writes into. */
  async publishVoice(): Promise<AudioSink> {
    const source = new AudioSource(TTS_SAMPLE_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('ai', source);
    const participant = this.room.localParticipant;
    if (!participant) throw new Error('not connected to the room');
    await participant.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    this.source = source;
    this.track = track;
    return {
      push: (frame) => source.captureFrame(new AudioFrame(frame, TTS_SAMPLE_RATE, 1, frame.length)),
      clear: () => source.clearQueue(),
    };
  }

  /**
   * Read the visitor's audio as 16 kHz mono PCM16 bytes until the track ends or `signal` says
   * stop. Resolves when the stream is exhausted; rejects only on a read error.
   */
  async pump(
    track: RemoteTrack,
    onBytes: (bytes: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = new AudioStream(track, { sampleRate: STT_SAMPLE_RATE, numChannels: 1 });
    const reader = stream.getReader();
    const stop = (): void => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) return;
        onBytes(int16ToBytes(value.data));
      }
    } finally {
      signal.removeEventListener('abort', stop);
      reader.releaseLock();
    }
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    try {
      if (this.track) await this.track.close(true).catch(() => undefined);
      else if (this.source) await this.source.close().catch(() => undefined);
    } finally {
      await this.room.disconnect().catch((error: unknown) => {
        this.options.log('voice.room.disconnect_failed', { error: String(error) });
      });
    }
  }
}
