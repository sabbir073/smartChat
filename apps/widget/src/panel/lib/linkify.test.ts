import { describe, expect, it } from 'vitest';
import { splitLinks } from './linkify.js';

describe('splitLinks', () => {
  it('finds http(s) links and leaves the sentence its punctuation', () => {
    expect(splitLinks('See https://acme.example/help. Thanks!')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'https://acme.example/help' },
      { kind: 'text', text: '. Thanks!' },
    ]);
  });

  it('leaves plain text, bare domains and other schemes alone', () => {
    expect(splitLinks('Go to acme.example or javascript:alert(1)')).toEqual([{ kind: 'text', text: 'Go to acme.example or javascript:alert(1)' }]);
    expect(splitLinks('')).toEqual([]);
  });

  it('handles several links and a link at the end', () => {
    const parts = splitLinks('A https://a.example/x and https://b.example/y');
    expect(parts.filter((p) => p.kind === 'link').map((p) => (p as { href: string }).href)).toEqual(['https://a.example/x', 'https://b.example/y']);
    expect(parts.at(-1)).toEqual({ kind: 'link', href: 'https://b.example/y' });
  });
});
