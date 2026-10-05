import type { VoiceLanguage } from '@smartchat/types';
import { FRAME_MS, FrameChunker, TTS_SAMPLE_RATE, samplesPerFrame, silence } from './pcm.js';
import { splitSentences } from './sentences.js';
import type { TtsRequest, TtsStream } from './speech-client.js';

/**
 * The AI's mouth: text in, paced audio frames out.
 *
 * A reply is spoken sentence by sentence. The request for sentence N+1 goes out the moment
 * sentence N starts playing, so the service renders ahead by one sentence and the first words
 * reach the caller after one short render rather than after the whole reply. Frames are handed
 * to the room at the rate they play - twenty milliseconds every twenty milliseconds, against a
 * monotonic clock, a small lead ahead of real time so a late tick does not become a gap - which
 * is what keeps a barge-in sharp: when the caller interrupts, only the lead is still queued, and
 * clearing it stops the voice within a tenth of a second rather than after everything already
 * rendered has played out.
 *
 * `speak` resolves when the last frame has actually played, not when it was handed over, so
 * "goodbye" is heard in full before the call is hung up.
 */

export interface AudioSink {
  /** One frame of Int16 mono at the speaker's sample rate. May take time when the room is full. */
  push(frame: Int16Array): Promise<void>;
  /** Drop whatever is queued and go silent now. */
  clear(): void;
}

export interface Synthesizer {
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsStream>;
}

export interface SpeakerOptions {
  tts: Synthesizer;
  sink: AudioSink;
  sampleRate?: number;
  frameMs?: number;
  /** How far ahead of real time frames are handed over. The cost of a barge-in, in audio. */
  leadMs?: number;
  /** The pause between sentences, as the service itself leaves when it renders a whole reply. */
  gapMs?: number;
  /** A frame later than this is a stall (slow render): the clock is re-anchored rather than the backlog dumped. */
  maxLateMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  split?: (text: string) => string[];
}

export interface SpeakRequest {
  text: string;
  language: VoiceLanguage;
  voice: string;
  speakerId?: number;
}

export interface SpeakResult {
  /** False when it was interrupted. */
  completed: boolean;
  sentences: number;
  frames: number;
  durationMs: number;
  /** From the call to the first frame handed over: what the caller waited before hearing anything. */
  firstAudioMs: number | null;
  cacheHits: number;
}

export const DEFAULT_LEAD_MS = 120;
const DEFAULT_GAP_MS = 160;
const DEFAULT_MAX_LATE_MS = 200;

export function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class Speaker {
  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly frameSamples: number;
  private readonly leadMs: number;
  private readonly gapFrames: number;
  private readonly maxLateMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly split: (text: string) => string[];
  private current: { controller: AbortController; done: Promise<void> } | null = null;

  constructor(private readonly options: SpeakerOptions) {
    this.sampleRate = options.sampleRate ?? TTS_SAMPLE_RATE;
    this.frameMs = options.frameMs ?? FRAME_MS;
    this.frameSamples = samplesPerFrame(this.sampleRate, this.frameMs);
    this.leadMs = options.leadMs ?? DEFAULT_LEAD_MS;
    this.gapFrames = Math.round((options.gapMs ?? DEFAULT_GAP_MS) / this.frameMs);
    this.maxLateMs = Math.max(options.maxLateMs ?? DEFAULT_MAX_LATE_MS, this.leadMs + this.frameMs);
    this.now = options.now ?? monotonicNow;
    this.sleep = options.sleep ?? abortableSleep;
    this.split = options.split ?? splitSentences;
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  /** Say this. Whatever was being said before is cut off first. */
  async speak(request: SpeakRequest, signal?: AbortSignal): Promise<SpeakResult> {
    await this.stopAndWait();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const run = this.run(request, controller.signal).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      if (this.current?.controller === controller) this.current = null;
    });
    this.current = {
      controller,
      done: run.then(
        () => undefined,
        () => undefined,
      ),
    };
    return run;
  }

  /** Cut the current utterance off now. The pending `speak` resolves with `completed: false`. */
  stop(): void {
    if (!this.current) return;
    this.current.controller.abort();
    this.options.sink.clear();
  }

  private async stopAndWait(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.stop();
    await current.done;
  }

  private async run(request: SpeakRequest, signal: AbortSignal): Promise<SpeakResult> {
    const sentences = this.split(request.text);
    const result: SpeakResult = {
      completed: true,
      sentences: sentences.length,
      frames: 0,
      durationMs: 0,
      firstAudioMs: null,
      cacheHits: 0,
    };
    if (sentences.length === 0) return result;

    const startedAt = this.now();
    const chunker = new FrameChunker(this.frameSamples);
    let base: number | null = null;
    let pushed = 0;

    const pace = async (frame: Int16Array): Promise<void> => {
      if (base === null) {
        base = this.now();
        result.firstAudioMs = base - startedAt;
      }
      const target = base + pushed * this.frameMs - this.leadMs;
      const wait = target - this.now();
      if (wait > 0) {
        await this.sleep(wait, signal);
      } else if (-wait > this.maxLateMs) {
        // The render stalled for longer than the lead covered. Starting the clock again from
        // here rebuilds the lead over the next few frames instead of pushing the whole backlog
        // at once, which the room would play as a rush.
        base = this.now() - pushed * this.frameMs;
      }
      signal.throwIfAborted();
      await this.options.sink.push(frame);
      pushed += 1;
    };

    const requestFor = (text: string): TtsRequest => ({
      text,
      language: request.language,
      voice: request.voice,
      sampleRate: this.sampleRate,
      ...(request.speakerId !== undefined ? { speakerId: request.speakerId } : {}),
    });

    try {
      let next: Promise<TtsStream> = this.options.tts.synthesize(requestFor(sentences[0]!), signal);
      for (let index = 0; index < sentences.length; index += 1) {
        const stream = await next;
        if (stream.cache === 'hit') result.cacheHits += 1;
        const following = sentences[index + 1];
        if (following !== undefined) {
          next = this.options.tts.synthesize(requestFor(following), signal);
          // Looked at when its turn comes; a rejection before then must not be an unhandled one.
          next.catch(() => undefined);
        }
        for await (const chunk of stream.chunks) {
          for (const frame of chunker.push(chunk)) await pace(frame);
        }
        const tail = chunker.flush();
        if (tail) await pace(tail);
        if (following !== undefined) {
          for (let gap = 0; gap < this.gapFrames; gap += 1) await pace(silence(this.frameSamples));
        }
      }
      // The lead is still queued in the room: wait for it to play before saying this is done.
      if (base !== null) {
        const remaining = base + pushed * this.frameMs - this.now();
        if (remaining > 0) await this.sleep(remaining, signal);
      }
    } catch (error) {
      if (signal.aborted) {
        this.options.sink.clear();
        result.completed = false;
      } else {
        throw error;
      }
    } finally {
      result.frames = pushed;
      result.durationMs = pushed * this.frameMs;
    }
    return result;
  }
}
