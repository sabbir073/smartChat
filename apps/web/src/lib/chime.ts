/**
 * The message sound, made rather than shipped.
 *
 * Two short notes a fifth apart, synthesised on the spot with the Web Audio API: no audio file to
 * host, nothing copied from anyone else's messenger, and no network request when a message
 * lands. Browsers refuse to play sound until the page has been interacted with, so the context
 * is created lazily and resumed on the first gesture; a chime asked for before that is simply
 * not played - there is no queue of pent-up beeps waiting for the first click.
 *
 * The ring for an incoming call is built the same way: a two-tone burst every three seconds
 * until it is stopped. Unlike a chime, a ring that was asked for before the first gesture does
 * start once the gesture comes - the call is still ringing, and the whole point of the sound is
 * that somebody notices it.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;
let unlocked = false;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Call once the page has had a click or a key: lets the next chime actually sound. */
export function unlockChime(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();
    unlocked = true;
    // A call that started ringing before the first gesture can sound now.
    if (ringWanted && ringTimer === null) startRing();
  } catch {
    // No audio on this page; the visual cues still show.
  }
}

/** Arm `unlockChime` on the first gesture, so a sound can play later without one. */
export function armChimeOnGesture(target: Document = document): void {
  const once = () => {
    unlockChime();
    target.removeEventListener('pointerdown', once, true);
    target.removeEventListener('keydown', once, true);
  };
  target.addEventListener('pointerdown', once, true);
  target.addEventListener('keydown', once, true);
}

/** The context, ready to play, or null when this page cannot make a sound yet. */
function playableContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    context ??= new Ctor();
    if (context.state === 'suspended') {
      if (!unlocked) return null;
      void context.resume();
    }
    return context;
  } catch {
    return null;
  }
}

/** Play the chime. Returns false when the page cannot play sound yet. */
export function playChime(volume = 0.22): boolean {
  const ctx = playableContext();
  if (!ctx) return false;
  try {
    const at = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    note(ctx, master, 659.25, at, 0.11); // E5
    note(ctx, master, 987.77, at + 0.09, 0.16); // B5
    return true;
  } catch {
    return false;
  }
}

/** How often the ring burst repeats, from the start of one burst to the start of the next. */
export const RING_PERIOD_MS = 3_000;

let ringWanted = false;
let ringTimer: number | null = null;

/**
 * Start ringing, and keep ringing until `stopRing` is called.
 *
 * Idempotent: a second call while already ringing changes nothing, so the provider can call it on
 * every change to the set of incoming calls without the rhythm stuttering. Returns false when the
 * page cannot sound yet; the ring then starts on the first gesture, see `unlockChime`.
 */
export function startRing(volume = 0.2): boolean {
  ringWanted = true;
  if (ringTimer !== null) return true;
  const ctx = playableContext();
  if (!ctx) return false;

  const burst = () => {
    try {
      const at = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      // A classic two-tone ring: two beats of a fourth, the second a touch longer.
      ringTone(ctx, master, at, 0.32);
      ringTone(ctx, master, at + 0.45, 0.4);
    } catch {
      // The context died under us; the next burst tries again and the card still shows.
    }
  };
  burst();
  ringTimer = window.setInterval(burst, RING_PERIOD_MS);
  return true;
}

export function stopRing(): void {
  ringWanted = false;
  if (ringTimer !== null) {
    window.clearInterval(ringTimer);
    ringTimer = null;
  }
}

export function isRinging(): boolean {
  return ringTimer !== null;
}

/** Two sines a fourth apart, which is what makes it read as a telephone rather than an alarm. */
function ringTone(ctx: AudioContext, out: GainNode, at: number, seconds: number): void {
  note(ctx, out, 440, at, seconds); // A4
  note(ctx, out, 587.33, at, seconds); // D5
}

function note(
  ctx: AudioContext,
  out: GainNode,
  frequency: number,
  at: number,
  seconds: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(1, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  osc.connect(gain);
  gain.connect(out);
  osc.start(at);
  osc.stop(at + seconds + 0.02);
}

/** Test seam: forget the context and the unlock, as a fresh page would. */
export function resetChimeForTests(): void {
  stopRing();
  context = null;
  unlocked = false;
}
