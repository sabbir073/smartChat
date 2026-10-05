import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RING_PERIOD_MS,
  isRinging,
  resetChimeForTests,
  startRing,
  stopRing,
  unlockChime,
} from './chime';

/**
 * When the ring sounds and when it stays quiet, against a stand-in for the Web Audio API.
 *
 * jsdom has no AudioContext, which is convenient: the "no audio at all" case is the default, and
 * the fake below is only installed where a context is meant to exist.
 */

let oscillatorsStarted = 0;

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  destination = {};
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    };
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
      start: () => {
        oscillatorsStarted += 1;
      },
      stop: () => undefined,
    };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

class SuspendedAudioContext extends FakeAudioContext {
  override state: 'running' | 'suspended' = 'suspended';
}

beforeEach(() => {
  vi.useFakeTimers();
  oscillatorsStarted = 0;
  resetChimeForTests();
});

afterEach(() => {
  stopRing();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the ring', () => {
  it('cannot ring on a page with no audio, and says so', () => {
    expect(startRing()).toBe(false);
    expect(isRinging()).toBe(false);
  });

  it('rings straight away on a page that may play sound, and repeats every three seconds', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    expect(startRing()).toBe(true);
    expect(isRinging()).toBe(true);
    // One burst is two tones of two sines each.
    expect(oscillatorsStarted).toBe(4);
    vi.advanceTimersByTime(RING_PERIOD_MS);
    expect(oscillatorsStarted).toBe(8);
    vi.advanceTimersByTime(RING_PERIOD_MS * 2);
    expect(oscillatorsStarted).toBe(16);
  });

  it('does not stutter when asked to start while already ringing', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    startRing();
    startRing();
    startRing();
    expect(oscillatorsStarted).toBe(4);
    vi.advanceTimersByTime(RING_PERIOD_MS);
    expect(oscillatorsStarted).toBe(8);
  });

  it('stops, and stays stopped', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    startRing();
    stopRing();
    expect(isRinging()).toBe(false);
    vi.advanceTimersByTime(RING_PERIOD_MS * 3);
    expect(oscillatorsStarted).toBe(4);
  });

  it('waits for the first gesture when the browser has not unlocked audio, then rings', () => {
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    expect(startRing()).toBe(false);
    expect(isRinging()).toBe(false);
    expect(oscillatorsStarted).toBe(0);

    // The click comes while the call is still ringing.
    unlockChime();
    expect(isRinging()).toBe(true);
    expect(oscillatorsStarted).toBe(4);
  });

  it('does not ring after the gesture if the call stopped ringing before it came', () => {
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    startRing();
    stopRing();
    unlockChime();
    expect(isRinging()).toBe(false);
    expect(oscillatorsStarted).toBe(0);
  });
});
