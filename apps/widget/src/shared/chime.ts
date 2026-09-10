/**
 * The message sound, made rather than shipped.
 *
 * Two short notes a fifth apart, synthesised on the spot with the Web Audio API: no audio file to
 * host, nothing copied from anyone else's messenger, and no network request when a message
 * lands. Browsers refuse to play sound until the page has been interacted with, so the context
 * is created lazily and resumed on the first gesture; a chime asked for before that is simply
 * not played - there is no queue of pent-up beeps waiting for the first click.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;
let unlocked = false;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
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

/** Play the chime. Returns false when the page cannot play sound yet. */
export function playChime(volume = 0.22): boolean {
  const Ctor = audioContextCtor();
  if (!Ctor) return false;
  try {
    context ??= new Ctor();
    if (context.state === 'suspended') {
      if (!unlocked) return false;
      void context.resume();
    }
    const at = context.currentTime;
    const master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);
    note(context, master, 659.25, at, 0.11); // E5
    note(context, master, 987.77, at + 0.09, 0.16); // B5
    return true;
  } catch {
    return false;
  }
}

function note(ctx: AudioContext, out: GainNode, frequency: number, at: number, seconds: number): void {
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
