import type { CallJoinGrant } from '@smartchat/types';

/**
 * The media room, from the dashboard's side.
 *
 * A thin wrapper over livekit-client that does exactly four things: connect with the grant the
 * API minted, publish the microphone, play whatever the other parties say, and leave. The
 * library is imported lazily because it is a quarter of a megabyte that the dashboard only needs
 * at the moment somebody presses Answer - every other screen never pays for it.
 *
 * Audio elements for the remote tracks live in a hidden container on the body rather than in a
 * React tree, so a re-render of the call bar can never unmount the sound of the caller.
 */

export interface CallRoomHandlers {
  /** The room went away: the server removed us, the call ended, or the network did. */
  onDisconnected(): void;
  /**
   * Whether the browser is refusing to play the other side until it sees a gesture. The screen
   * shows a "tap to hear" control while true; `startAudio` from a click clears it.
   */
  onAudioBlocked(blocked: boolean): void;
  /** The microphone could not be opened. We stay in the room - hearing is better than nothing. */
  onMicrophoneError(message: string): void;
}

export interface CallRoom {
  /** Mute or unmute the microphone. Resolves once the track state has actually changed. */
  setMuted(muted: boolean): Promise<void>;
  isMuted(): boolean;
  /** Ask the browser to play the remote audio; call from a click when `onAudioBlocked(true)` fired. */
  startAudio(): Promise<void>;
  /** Leave and release the microphone. Safe to call twice. */
  disconnect(): Promise<void>;
}

/**
 * Join the room named by the grant and start talking.
 *
 * Resolves once the signalling connection is up; the microphone is published right after, and a
 * refusal there is reported rather than thrown, because a person who cannot be heard can still
 * hear the caller and type to them.
 */
export async function connectCallRoom(
  grant: CallJoinGrant,
  handlers: CallRoomHandlers,
): Promise<CallRoom> {
  const { Room, RoomEvent, Track } = await import('livekit-client');

  const room = new Room({
    // Voice only: nothing to adapt or simulcast, and the defaults for those cost a little CPU.
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.style.display = 'none';
  document.body.appendChild(container);

  let gone = false;
  const cleanup = () => {
    if (gone) return;
    gone = true;
    container.remove();
  };

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    container.appendChild(element);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    for (const element of track.detach()) element.remove();
  });
  room.on(RoomEvent.AudioPlaybackStatusChanged, () =>
    handlers.onAudioBlocked(!room.canPlaybackAudio),
  );
  room.on(RoomEvent.MediaDevicesError, (error, kind) => {
    if (kind === undefined || kind === 'audioinput')
      handlers.onMicrophoneError(describeMicrophoneError(error));
  });
  room.on(RoomEvent.Disconnected, () => {
    cleanup();
    handlers.onDisconnected();
  });

  try {
    await room.connect(grant.url, grant.token);
  } catch (error) {
    cleanup();
    throw error;
  }

  try {
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (error) {
    handlers.onMicrophoneError(describeMicrophoneError(error));
  }
  // The browser may already be refusing playback; say so now rather than at the first word.
  if (!room.canPlaybackAudio) handlers.onAudioBlocked(true);

  return {
    async setMuted(muted) {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
    isMuted() {
      return !room.localParticipant.isMicrophoneEnabled;
    },
    async startAudio() {
      await room.startAudio();
      handlers.onAudioBlocked(!room.canPlaybackAudio);
    },
    async disconnect() {
      await room.disconnect(true);
      cleanup();
    },
  };
}

/** One honest sentence for a microphone failure, since the browser's own wording is for developers. */
export function describeMicrophoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access was refused. Allow it in the browser and reconnect to be heard.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. The caller cannot hear you.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is in use by another application. The caller cannot hear you.';
    default:
      return 'The microphone could not be started. The caller cannot hear you.';
  }
}
