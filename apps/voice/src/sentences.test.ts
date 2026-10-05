import { describe, expect, it } from 'vitest';
import { splitSentences } from './sentences.js';

describe('splitSentences', () => {
  it('cuts at full stops, question and exclamation marks followed by space, and at newlines', () => {
    expect(
      splitSentences('We open at nine. Do you need the address? Great!\nSee you then.'),
    ).toEqual(['We open at nine.', 'Do you need the address?', 'Great!', 'See you then.']);
  });

  it('cuts Bengali at the danda', () => {
    expect(splitSentences('আমরা সকাল নয়টায় খুলি। আপনার কি ঠিকানা লাগবে?')).toEqual([
      'আমরা সকাল নয়টায় খুলি।',
      'আপনার কি ঠিকানা লাগবে?',
    ]);
  });

  it('does not cut inside a decimal or after an abbreviation', () => {
    expect(splitSentences('It costs 1.5 taka. Ask Dr. Rahman, e.g. tomorrow.')).toEqual([
      'It costs 1.5 taka.',
      'Ask Dr. Rahman, e.g. tomorrow.',
    ]);
  });

  it('cuts after a closing quote or bracket, as the service does', () => {
    // The closing quote goes with the separator - the service drops it the same way, and a
    // quote mark was never going to be spoken.
    expect(splitSentences('He said "hello." Then he left (quietly). Done')).toEqual([
      'He said "hello.',
      'Then he left (quietly).',
      'Done',
    ]);
  });

  it('drops fragments with nothing to say', () => {
    expect(splitSentences('Hi. ... !! a. 🙂')).toEqual(['Hi.', 'a.']);
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });

  it('splits an over-long sentence at commas, then at spaces, under the cap', () => {
    const clause = 'this clause is twenty chars';
    const long = Array.from({ length: 6 }, () => clause).join(', ');
    const pieces = splitSentences(long, 60);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 60)).toBe(true);
    expect(pieces.join(' ').replaceAll(',', '')).toBe(long.replaceAll(',', ''));

    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const byWords = splitSentences(words, 40);
    expect(byWords.every((piece) => piece.length <= 40)).toBe(true);
    expect(byWords.join(' ')).toBe(words);
  });

  it('cuts a word longer than the cap rather than loop forever', () => {
    expect(splitSentences('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });
});
