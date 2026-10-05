import { describe, expect, it } from 'vitest';
import { FrameChunker, bytesToInt16, int16ToBytes, samplesPerFrame } from './pcm.js';

describe('pcm', () => {
  it('rounds trips samples through little-endian bytes', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
    const bytes = int16ToBytes(samples);
    expect(bytes).toEqual(new Uint8Array([0, 0, 1, 0, 255, 255, 255, 127, 0, 128, 210, 4]));
    expect(bytesToInt16(bytes)).toEqual(samples);
  });

  it('knows a 20 ms frame at the two rates', () => {
    expect(samplesPerFrame(24_000)).toBe(480);
    expect(samplesPerFrame(16_000)).toBe(320);
  });
});

describe('FrameChunker', () => {
  it('turns arbitrary byte pieces into whole frames, carrying half samples and partial frames', () => {
    const chunker = new FrameChunker(4);
    const samples = new Int16Array(Array.from({ length: 11 }, (_, i) => i + 1));
    const bytes = int16ToBytes(samples);
    // Pieces that split a sample (odd lengths) and a frame.
    const frames = [
      ...chunker.push(bytes.subarray(0, 3)),
      ...chunker.push(bytes.subarray(3, 10)),
      ...chunker.push(bytes.subarray(10, 11)),
      ...chunker.push(bytes.subarray(11)),
    ];
    expect(frames.map((frame) => [...frame])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect([...chunker.flush()!]).toEqual([9, 10, 11, 0]);
    expect(chunker.flush()).toBeNull();
  });

  it('yields nothing for an empty push and nothing to flush on a boundary', () => {
    const chunker = new FrameChunker(2);
    expect(chunker.push(new Uint8Array(0))).toEqual([]);
    expect(chunker.push(int16ToBytes(new Int16Array([5, 6])))).toHaveLength(1);
    expect(chunker.flush()).toBeNull();
  });
});
