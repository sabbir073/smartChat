/**
 * PCM16 helpers for the two audio paths.
 *
 * Out: the speech service answers a TTS request with PCM16LE bytes in whatever pieces HTTP
 * delivers them, and the room wants Int16 frames of exactly twenty milliseconds. In: the room
 * hands over Int16 frames and the speech service wants bytes. Both conversions are small, both
 * must survive a chunk boundary falling in the middle of a sample, and both are easier to trust
 * when they sit in one place with their own tests.
 */

export const FRAME_MS = 20;
/** What the speech service listens at. */
export const STT_SAMPLE_RATE = 16_000;
/** What the AI's voice is rendered at: Kokoro's native rate, and the room resamples the rest. */
export const TTS_SAMPLE_RATE = 24_000;

export function samplesPerFrame(sampleRate: number, frameMs = FRAME_MS): number {
  return Math.round((sampleRate * frameMs) / 1000);
}

/** Int16 samples as the little-endian bytes the speech service reads. */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

/** Little-endian bytes as Int16 samples. A trailing odd byte is dropped; see FrameChunker for the streaming case. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Int16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * Turns a byte stream of PCM16LE into fixed-size frames.
 *
 * HTTP chunks fall where they fall - a sample can be split across two reads, and a frame across
 * many - so a byte is carried when a chunk ends mid-sample and samples are carried when a chunk
 * ends mid-frame. `flush` pads the last partial frame with silence rather than dropping the end
 * of a sentence.
 */
export class FrameChunker {
  private oddByte: number | null = null;
  private pending: Int16Array;
  private filled = 0;

  constructor(private readonly frameSamples: number) {
    this.pending = new Int16Array(frameSamples);
  }

  push(bytes: Uint8Array): Int16Array[] {
    let input = bytes;
    if (this.oddByte !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.oddByte;
      joined.set(bytes, 1);
      input = joined;
      this.oddByte = null;
    }
    if (input.length % 2 === 1) {
      this.oddByte = input[input.length - 1] ?? 0;
      input = input.subarray(0, input.length - 1);
    }
    const samples = bytesToInt16(input);
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSamples - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSamples) {
        frames.push(this.pending);
        this.pending = new Int16Array(this.frameSamples);
        this.filled = 0;
      }
    }
    return frames;
  }

  /** The partial frame at the end, padded with silence, or null when the stream ended on a boundary. */
  flush(): Int16Array | null {
    if (this.filled === 0) return null;
    const frame = this.pending;
    this.pending = new Int16Array(this.frameSamples);
    this.filled = 0;
    this.oddByte = null;
    return frame;
  }
}

/** A frame of nothing, for the pause between sentences. */
export function silence(frameSamples: number): Int16Array {
  return new Int16Array(frameSamples);
}
