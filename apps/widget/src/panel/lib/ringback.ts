/**
 * The ringing the visitor hears while the team is being rung.
 *
 * Generated rather than shipped as a file: two sine tones at 440 Hz and 480 Hz, 2 s on and 4 s
 * off - the cadence a phone makes - cost nothing to download and need no audio asset to be
 * served from the CDN. The whole thing is a few nodes in a WebAudio graph.
 */
export interface Ringback {
  /**
   * Create the audio context while the visitor's tap is still "live" in the browser's eyes.
   *
   * Browsers only let a page make sound after a gesture, and the call starts a few awaits after
   * the tap. The context made here, inside the tap, stays usable afterwards.
   */
  prime(): void;
  start(): void;
  stop(): void;
}

const TONE_HZ = [440, 480] as const;
const ON_MS = 2000;
const PERIOD_MS = 6000;
/** Quiet: this plays next to a page the visitor is still reading. */
const VOLUME = 0.08;
const RAMP_S = 0.015;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createRingback(): Ringback {
  let context: AudioContext | null = null;
  let gain: GainNode | null = null;
  let oscillators: OscillatorNode[] = [];
  let timer: number | null = null;

  function prime(): void {
    if (context) {
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      context = new Ctor();
    } catch {
      context = null;
    }
  }

  /** One burst: fade in, hold, fade out. Scheduled on the audio clock so it never stutters. */
  function burst(): void {
    if (!context || !gain) return;
    const at = context.currentTime;
    const level = gain.gain;
    level.cancelScheduledValues(at);
    level.setValueAtTime(0, at);
    level.linearRampToValueAtTime(VOLUME, at + RAMP_S);
    level.setValueAtTime(VOLUME, at + ON_MS / 1000 - RAMP_S);
    level.linearRampToValueAtTime(0, at + ON_MS / 1000);
  }

  function start(): void {
    if (timer !== null) return;
    prime();
    if (!context) return;
    const graph = context;
    try {
      const node = graph.createGain();
      node.gain.value = 0;
      node.connect(graph.destination);
      gain = node;
      oscillators = TONE_HZ.map((frequency) => {
        const oscillator = graph.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        oscillator.connect(node);
        oscillator.start();
        return oscillator;
      });
    } catch {
      // No sound, then. The bar still says "Calling…".
      teardown();
      return;
    }
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    burst();
    timer = window.setInterval(burst, PERIOD_MS);
  }

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    teardown();
  }

  function teardown(): void {
    for (const oscillator of oscillators) {
      try {
        oscillator.stop();
        oscillator.disconnect();
      } catch {
        /* already stopped */
      }
    }
    oscillators = [];
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        /* already gone */
      }
      gain = null;
    }
  }

  return { prime, start, stop };
}
