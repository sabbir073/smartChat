import { describe, expect, it } from 'vitest';
import { chunkDocument, contentHash, estimateTokens, plainText } from './chunker.js';

describe('chunkDocument', () => {
  it('keeps a short document as one passage', () => {
    const chunks = chunkDocument('We ship everywhere in Bangladesh.\n\nReturns within 14 days.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, heading: null });
    expect(chunks[0]!.text).toContain('Returns within 14 days');
  });

  it('carries the heading a paragraph sits under', () => {
    const chunks = chunkDocument('# Shipping\n\nFree above 5,000 BDT.\n\n## Returns\n\nWithin 14 days.');
    expect(chunks.map((c) => c.heading)).toEqual(['Shipping', 'Returns']);
  });

  it('splits long prose near the target and overlaps the boundary', () => {
    const paragraph = 'The frame carries a two year warranty against defects. ';
    const text = Array.from({ length: 12 }, (_, i) => `${paragraph}Paragraph ${i}.`).join('\n\n');
    const chunks = chunkDocument(text, { targetTokens: 60, maxTokens: 100, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(110);
    // The tail of one passage opens the next, so a fact on the boundary is in both.
    const tail = chunks[0]!.text.split(' ').slice(-3).join(' ');
    expect(chunks[1]!.text.indexOf(tail)).toBeGreaterThanOrEqual(0);
    expect(chunks[1]!.text.indexOf(tail)).toBeLessThan(80);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('never produces a passage over the ceiling, even from one long paragraph', () => {
    const sentence = 'Wear items such as tyres, brake pads and chains are not covered by the warranty. ';
    const chunks = chunkDocument(sentence.repeat(60), { targetTokens: 100, maxTokens: 150 });
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(160);
  });
});

describe('estimateTokens', () => {
  it('counts non-Latin script heavier than English', () => {
    expect(estimateTokens('four')).toBe(1);
    expect(estimateTokens('শুক্রবার')).toBeGreaterThan(4);
  });
});

describe('plainText', () => {
  it('flattens markdown to what a model should read', () => {
    expect(plainText('**Bold** and [a link](https://x.example) and ![img](/a.png)')).toBe(
      'Bold and a link (https://x.example) and ',
    );
  });
});

describe('contentHash', () => {
  it('changes when the title or the text changes', () => {
    expect(contentHash('a', 'b')).not.toBe(contentHash('a', 'c'));
    expect(contentHash('a', 'b')).not.toBe(contentHash('x', 'b'));
    expect(contentHash('a', 'b')).toBe(contentHash('a', 'b'));
  });
});
