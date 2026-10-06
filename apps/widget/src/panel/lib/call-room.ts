/**
 * The media room, behind an interface the rest of the panel can fake.
 *
 * LiveKit's client is a third of the panel's size, and most visitors never call, so it is loaded
 * on the first call rather than with the panel: the `import()` below is what makes Vite emit it
 * as its own chunk. Everything LiveKit-specific lives in this file; the controller only knows
 * `CallRoom`.
 */

/**
 * Why the room went away, in the three ways the call cares about.
 *
 * `closed`: the media server shut the room, which is what happens when the call ends - the
 * server's word on the call is on its way. `elsewhere`: the visitor joined the same call from
 * another tab and that tab has it now. `network`: the connection dropped and did not recover.
 */
export type RoomLossReason = 'network' | 'closed' | 'elsewhere';

export interface CallRoomHandlers {
  /** The room connection is gone and will not come back on its own. */
  onDisconnected(reason: RoomLossReason): void;
  /** Whether the browser is refusing to play the other side until the visitor taps something. */
  onAudioBlocked(blocked: boolean): void;
}

export interface CallRoom {
  connect(url: string, token: string): Promise<void>;
  /** Publish the microphone, or stop publishing it. The first call asks the visitor. */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  /** Start playing the other side. Only helps inside a tap when the browser blocked playback. */
  startAudio(): Promise<void>;
  disconnect(): Promise<void>;
}

export type CallRoomFactory = (handlers: CallRoomHandlers) => Promise<CallRoom>;

/**
 * Ask for the microphone before anything rings.
 *
 * A refused microphone must not ring the whole team for a call that cannot happen, so the
 * permission is settled first and the call started only once it is granted. The stream opened
 * here is closed at once; LiveKit opens its own, with its own processing, once the room is up.
 */
export async function requestMicrophone(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

/** The capture options every call uses: a voice call wants a clean, level voice. */
const CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/**
 * How the voice is sent: tuned for a phone call, not for music.
 *
 * 32 kbps mono Opus is clear for speech and leaves room on a weak mobile uplink, where the
 * library's 48 kbps default plus redundancy is the first thing to start losing packets. Discontinuous
 * transmission is off: it saves a few kilobits in pauses at the cost of clipped first syllables
 * and a jitter buffer that has to relearn the line after every silence. Redundant audio stays on,
 * so a lost packet is replaced by its copy in the next one instead of a gap. The same values are
 * used by the dashboard (apps/web/src/lib/call-room.ts).
 */
const PUBLISH = {
  audioPreset: { maxBitrate: 32_000, priority: 'high' as const },
  dtx: false,
  red: true,
};

export const createLiveKitRoom: CallRoomFactory = async (handlers) => {
  const lk = await import('livekit-client');
  const room = new lk.Room({
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: CAPTURE,
    publishDefaults: PUBLISH,
  });
  /** Set before a deliberate disconnect, so the event it raises is not read as a loss. */
  let closing = false;

  /**
   * Where the audio elements live.
   *
   * `track.attach()` makes an `<audio autoplay playsinline>` per track; Safari plays an element
   * more reliably when it is in the document, so each one is parked in a hidden container and
   * removed again when the track goes.
   */
  const parking = document.createElement('div');
  parking.setAttribute('aria-hidden', 'true');
  parking.style.display = 'none';
  document.body.appendChild(parking);

  room.on(lk.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== lk.Track.Kind.Audio) return;
    parking.appendChild(track.attach());
  });
  room.on(lk.RoomEvent.TrackUnsubscribed, (track) => {
    for (const element of track.detach()) element.remove();
  });
  room.on(lk.RoomEvent.AudioPlaybackStatusChanged, (playing) => handlers.onAudioBlocked(!playing));
  room.on(lk.RoomEvent.Disconnected, (reason) => {
    if (closing) return;
    const closed =
      reason === lk.DisconnectReason.ROOM_DELETED ||
      reason === lk.DisconnectReason.ROOM_CLOSED ||
      reason === lk.DisconnectReason.PARTICIPANT_REMOVED;
    handlers.onDisconnected(
      closed
        ? 'closed'
        : reason === lk.DisconnectReason.DUPLICATE_IDENTITY
          ? 'elsewhere'
          : 'network',
    );
  });

  return {
    connect: (url, token) => room.connect(url, token),
    async setMicrophoneEnabled(enabled) {
      await room.localParticipant.setMicrophoneEnabled(enabled, CAPTURE);
    },
    startAudio: () => room.startAudio(),
    async disconnect() {
      closing = true;
      try {
        await room.disconnect(true);
      } finally {
        for (const element of Array.from(parking.querySelectorAll('audio'))) {
          element.srcObject = null;
          element.remove();
        }
        parking.remove();
      }
    },
  };
};
