import { useEffect, useState } from 'react';
import type { CallSnapshot } from '../lib/call-controller.js';
import { elapsedSeconds, formatClock, liveText } from '../lib/call-state.js';

/**
 * The strip under the header while a call is anything but idle.
 *
 * It renders from the latest snapshot and nothing else: what the call is doing is the server's
 * word, whether the microphone is muted and whether the room is up are the controller's. The
 * chat underneath keeps working - the visitor can type while they talk.
 */
export function CallBar({
  snapshot,
  onMute,
  onHangUp,
  onUnblockAudio,
}: {
  snapshot: CallSnapshot;
  onMute: (muted: boolean) => void;
  onHangUp: () => void;
  onUnblockAudio: () => void;
}) {
  const { phase } = snapshot;
  const live = phase.kind === 'live' ? phase : null;
  const answeredAt = live?.call.answeredAt ?? null;
  const [clock, setClock] = useState(() => elapsedSeconds(answeredAt, Date.now()));

  /**
   * The timer ticks once a second from the moment the call was answered - the server's moment,
   * not this panel's, so a reload mid-call shows the real length rather than starting again.
   */
  useEffect(() => {
    const tick = () => setClock(elapsedSeconds(answeredAt, Date.now()));
    tick();
    if (!answeredAt) return undefined;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [answeredAt]);

  if (phase.kind === 'idle') return null;

  const tone = phase.kind === 'over' ? 'over' : live?.room === 'lost' ? 'lost' : 'live';
  const text =
    phase.kind === 'starting'
      ? 'Starting call…'
      : phase.kind === 'over'
        ? phase.text
        : live
          ? liveText(live)
          : '';
  const showClock = Boolean(live && answeredAt && live.room !== 'lost');
  const ringing = live !== null && live.call.status === 'ringing' && !live.call.answeredAt;

  return (
    <div className="call-bar" data-tone={tone}>
      <span className="call-bar-icon" data-ringing={ringing || undefined} aria-hidden="true">
        <PhoneIcon />
      </span>
      <span className="call-bar-text">
        {/* Only the status line is announced. The clock changes every second, and a screen
            reader that read it out every second would make the call impossible to follow. */}
        <span className="call-bar-status" role="status">
          {text}
        </span>
        {showClock && (
          <span className="call-bar-clock" aria-hidden="true">
            {formatClock(clock)}
          </span>
        )}
      </span>

      {live && live.room !== 'lost' && (
        <span className="call-bar-actions">
          {snapshot.audioBlocked && (
            <button type="button" className="call-bar-unblock" onClick={onUnblockAudio}>
              Tap to hear
            </button>
          )}
          <button
            type="button"
            className="call-bar-button"
            aria-pressed={live.muted}
            aria-label={live.muted ? 'Unmute microphone' : 'Mute microphone'}
            title={live.muted ? 'Unmute' : 'Mute'}
            // There is no microphone to mute until the room is up.
            disabled={snapshot.hangingUp || live.room !== 'joined'}
            onClick={() => onMute(!live.muted)}
          >
            <MicrophoneIcon muted={live.muted} />
          </button>
          <button
            type="button"
            className="call-bar-button call-bar-hangup"
            aria-label="Hang up"
            title="Hang up"
            disabled={snapshot.hangingUp}
            onClick={onHangUp}
          >
            <HangUpIcon />
          </button>
        </span>
      )}
    </div>
  );
}

export function PhoneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.96.36 1.9.74 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.45c.9.38 1.84.63 2.8.74A2 2 0 0 1 22 16.9z" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.7 13.3a16 16 0 0 1-2.6-2.6l1.2-1.2a2 2 0 0 0 .5-2.1 11 11 0 0 1-.6-2.8A2 2 0 0 0 7.2 3H4.2a2 2 0 0 0-2 2.2 19.8 19.8 0 0 0 3 8.6" />
      <path d="M22 15.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1" />
      <path d="M3 21 21 3" />
    </svg>
  );
}

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** The small microphone before a line that was spoken on a call rather than typed. */
export function SpokenGlyph() {
  return (
    <svg
      className="spoken-glyph"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Said on a call"
      role="img"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  );
}
