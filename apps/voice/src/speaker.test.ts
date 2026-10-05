import { describe, expect, it } from 'vitest';
import { int16ToBytes } from './pcm.js';
import { Speaker, type AudioSink, type Synthesizer } from './speaker.js';
import type { TtsRequest, TtsStream } from './speech-client.js';

/**
 * The speaker against a virtual clock: sleeping moves the clock, nothing waits. What is pinned
 * is the shape of the pipeline - the next sentence requested while this one plays, frames of
 * exactly twenty milliseconds handed over at the rate they play with a small lead, a pause
 * between sentences, the promise resolving when the sound ends - and that a stop cuts it off.
 */

class VirtualClock {
  time = 0;
  now = (): number => this.time;
  sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    this.time += ms;
    return Promise.resolve();
  };
}

class RecordingSink implements AudioSink {
  frames: Array<{ at: number; samples: Int16Array }> = [];
  cleared = 0;
  constructor(private readonly clock: VirtualClock) {}
  async push(frame: Int16Array): Promise<void> {
    this.frames.push({ at: this.clock.time, samples: frame });
  }
  clear(): void {
    this.cleared += 1;
  }
}

interface FakeTtsOptions {
  /** Samples per sentence; split into two chunks, the second after a stall of this many ms. */
  samples?: number;
  stallMs?: number;
  cache?: 'hit' | 'miss';
  fail?: boolean;
}

class FakeTts implements Synthesizer {
  requests: Array<{ at: number; request: TtsRequest }> = [];
  constructor(
    private readonly clock: VirtualClock,
    private readonly options: FakeTtsOptions = {},
  ) {}

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsStream> {
    this.requests.push({ at: this.clock.time, request });
    if (this.options.fail) throw new Error('tts exploded');
    const samples = this.options.samples ?? 1_000;
    const value = Int16Array.from({ length: samples }, (_, i) => (i % 100) - 50);
    const bytes = int16ToBytes(value);
    const half = Math.floor(bytes.length / 2) + 1; // deliberately odd: a sample split across chunks
    const { clock, options } = this;
    const chunks = (async function* (): AsyncIterable<Uint8Array> {
      if (signal?.aborted) throw new Error('aborted');
      yield bytes.subarray(0, half);
      if (options.stallMs) clock.time += options.stallMs;
      if (signal?.aborted) throw new Error('aborted');
      yield bytes.subarray(half);
    })();
    return { cache: this.options.cache ?? 'miss', sentences: 1, sampleRate: 24_000, chunks };
  }
}

function setup(options: FakeTtsOptions = {}): {
  clock: VirtualClock;
  sink: RecordingSink;
  tts: FakeTts;
  speaker: Speaker;
} {
  const clock = new VirtualClock();
  const sink = new RecordingSink(clock);
  const tts = new FakeTts(clock, options);
  const speaker = new Speaker({
    tts,
    sink,
    now: clock.now,
    sleep: clock.sleep,
    leadMs: 100,
    gapMs: 160,
  });
  return { clock, sink, tts, speaker };
}

describe('Speaker', () => {
  it('speaks sentence by sentence, asking for the next one while the first plays', async () => {
    const { sink, tts, speaker } = setup({ samples: 960 });
    const result = await speaker.speak({
      text: 'First sentence. Second one!',
      language: 'en',
      voice: 'en_female',
    });

    expect(tts.requests.map((entry) => entry.request.text)).toEqual([
      'First sentence.',
      'Second one!',
    ]);
    expect(tts.requests[0]!.request).toMatchObject({
      language: 'en',
      voice: 'en_female',
      sampleRate: 24_000,
    });
    // The second request went out before a single frame of the first sentence was handed over.
    expect(tts.requests[1]!.at).toBeLessThanOrEqual(sink.frames[0]!.at);

    // 960 samples = 2 frames per sentence, 8 frames of silence between them.
    expect(result).toMatchObject({
      completed: true,
      sentences: 2,
      frames: 12,
      durationMs: 240,
      cacheHits: 0,
    });
    expect(sink.frames.every((frame) => frame.samples.length === 480)).toBe(true);
    const gap = sink.frames.slice(2, 10);
    expect(gap.every((frame) => frame.samples.every((sample) => sample === 0))).toBe(true);
    expect(sink.frames[10]!.samples.some((sample) => sample !== 0)).toBe(true);
  });

  it('paces frames in real time with the lead, and resolves when the sound has ended', async () => {
    const { clock, sink, speaker } = setup({ samples: 480 * 10 });
    const result = await speaker.speak({
      text: 'One sentence of ten frames.',
      language: 'en',
      voice: 'en_female',
    });
    expect(result.frames).toBe(10);
    const base = sink.frames[0]!.at;
    // The first five frames fill the 100 ms lead at once; from then on, one every 20 ms.
    expect(sink.frames.slice(0, 5).map((frame) => frame.at - base)).toEqual([0, 0, 0, 0, 0]);
    expect(sink.frames.slice(5).map((frame) => frame.at - base)).toEqual([0, 20, 40, 60, 80]);
    // Ten frames are 200 ms of sound: the promise waited for the last one to play.
    expect(clock.time - base).toBe(200);
    expect(result.firstAudioMs).toBe(0);
  });

  it('re-anchors after a stall instead of dumping the backlog in one burst', async () => {
    const { sink, speaker } = setup({ samples: 480 * 20, stallMs: 1_000 });
    await speaker.speak({
      text: 'One sentence of twenty frames.',
      language: 'en',
      voice: 'en_female',
    });
    const times = sink.frames.map((frame) => frame.at);
    expect(times).toHaveLength(20);
    // The first half: the lead, then real time. The stall sits between frame 9 and frame 10.
    expect(times[9]! - times[0]!).toBe(80);
    expect(times[10]! - times[9]!).toBeGreaterThanOrEqual(1_000);
    // After the stall the lead is rebuilt at once (five frames) and then it is real time again,
    // rather than the remaining ten frames all at the same instant.
    const afterStall = times.slice(10);
    expect(afterStall.slice(0, 5).every((at) => at === afterStall[0])).toBe(true);
    expect(afterStall.slice(5).map((at) => at - afterStall[0]!)).toEqual([0, 20, 40, 60, 80]);
  });

  it('pads the last partial frame with silence', async () => {
    const { sink, speaker } = setup({ samples: 500 });
    const result = await speaker.speak({ text: 'Short.', language: 'en', voice: 'en_female' });
    expect(result.frames).toBe(2);
    expect(sink.frames[1]!.samples.slice(20).every((sample) => sample === 0)).toBe(true);
  });

  it('stops at once when told to, clearing the sink and reporting the cut', async () => {
    const clock = new VirtualClock();
    const sink = new RecordingSink(clock);
    let released: (() => void) | null = null;
    const tts: Synthesizer = {
      async synthesize(_request, signal) {
        const chunks = (async function* (): AsyncIterable<Uint8Array> {
          yield int16ToBytes(new Int16Array(480));
          // The service is slow with the rest; the caller interrupts meanwhile.
          await new Promise<void>((resolve) => {
            released = resolve;
          });
          if (signal?.aborted) throw new Error('aborted');
          yield int16ToBytes(new Int16Array(480 * 5));
        })();
        return { cache: 'miss', sentences: 1, sampleRate: 24_000, chunks };
      },
    };
    const speaker = new Speaker({ tts, sink, now: clock.now, sleep: clock.sleep, leadMs: 100 });
    const speaking = speaker.speak({
      text: 'A long one.',
      language: 'bn',
      voice: 'bn_bd',
      speakerId: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(speaker.speaking).toBe(true);
    speaker.stop();
    released!();
    const result = await speaking;
    expect(result.completed).toBe(false);
    expect(result.frames).toBe(1);
    expect(sink.cleared).toBeGreaterThanOrEqual(1);
    expect(speaker.speaking).toBe(false);
  });

  it('cuts the previous utterance when a new one starts', async () => {
    const clock = new VirtualClock();
    const sink = new RecordingSink(clock);
    let gate: (() => void) | null = null;
    const tts: Synthesizer = {
      async synthesize(request, signal) {
        const chunks = (async function* (): AsyncIterable<Uint8Array> {
          yield int16ToBytes(new Int16Array(480));
          if (request.text.startsWith('Slow')) {
            await new Promise<void>((resolve) => {
              gate = resolve;
            });
            if (signal?.aborted) throw new Error('aborted');
          }
        })();
        return { cache: 'miss', sentences: 1, sampleRate: 24_000, chunks };
      },
    };
    const speaker = new Speaker({ tts, sink, now: clock.now, sleep: clock.sleep });
    const first = speaker.speak({ text: 'Slow one.', language: 'en', voice: 'v' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = speaker.speak({ text: 'Quick.', language: 'en', voice: 'v' });
    gate!();
    expect((await first).completed).toBe(false);
    expect((await second).completed).toBe(true);
  });

  it('has nothing to say for empty text and counts cache hits otherwise', async () => {
    const empty = setup();
    const nothing = await empty.speaker.speak({ text: '  \n ', language: 'en', voice: 'v' });
    expect(nothing).toMatchObject({ completed: true, sentences: 0, frames: 0 });
    expect(empty.tts.requests).toEqual([]);

    const cached = setup({ cache: 'hit', samples: 480 });
    const result = await cached.speaker.speak({ text: 'Hello. Bye.', language: 'en', voice: 'v' });
    expect(result.cacheHits).toBe(2);
  });

  it('rejects when the service fails, so the session can count it', async () => {
    const { speaker } = setup({ fail: true });
    await expect(speaker.speak({ text: 'Hello.', language: 'en', voice: 'v' })).rejects.toThrow(
      'tts exploded',
    );
    expect(speaker.speaking).toBe(false);
  });
});
