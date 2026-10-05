/**
 * Sentences, cut the way the speech service cuts them.
 *
 * The agent asks for one sentence at a time so the first words reach the caller while the rest
 * is still being rendered, and so a barge-in throws away one short request rather than a whole
 * reply. The rules here mirror `speech/text/sentences.py` on purpose: a sentence ends at a danda,
 * a full stop, a question or exclamation mark followed by whitespace, or at a newline; a dot
 * after an abbreviation does not end one; anything shorter than two speakable characters is
 * dropped; anything longer than the cap is split at commas, then at spaces. Diverging here would
 * mean the service's own cache, keyed on normalised sentences, misses what it already rendered.
 */

export const MAX_SENTENCE_CHARS = 300;
const MIN_SENTENCE_CHARS = 2;

const SENTENCE_END = /(?<=[।.?!])["'”’)\]]*\s+|\n+/u;
const CLAUSE_SPLIT = /(?<=[,;:،])\s+/u;
const ABBREVIATION =
  /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|No|vs|etc|e\.g|i\.e|approx|Tk|Rs|ডা|মো|মোঃ|জনাব)\.$/iu;
const SPEAKABLE = /[\p{L}\p{N}]/u;

export function splitSentences(text: string, maxChars = MAX_SENTENCE_CHARS): string[] {
  const sentences: string[] = [];
  for (const raw of text.split(SENTENCE_END)) {
    const candidate = raw.trim();
    if (!candidate) continue;
    const previous = sentences[sentences.length - 1];
    // "Dr. Rahman" and "e.g. this": the dot after an abbreviation is not a sentence end.
    if (previous !== undefined && ABBREVIATION.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${candidate}`;
      continue;
    }
    sentences.push(candidate);
  }
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length < MIN_SENTENCE_CHARS || !SPEAKABLE.test(sentence)) continue;
    out.push(...cap(sentence, maxChars));
  }
  return out;
}

/** Split an over-long sentence at commas, then at spaces, keeping every piece under the cap. */
function cap(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const pieces: string[] = [];
  let current = '';
  for (const clause of sentence.split(CLAUSE_SPLIT)) {
    if (current && current.length + 1 + clause.length > maxChars) {
      pieces.push(current);
      current = clause;
    } else {
      current = `${current} ${clause}`.trim();
    }
  }
  if (current) pieces.push(current);
  const out: string[] = [];
  for (let piece of pieces) {
    while (piece.length > maxChars) {
      let cut = piece.lastIndexOf(' ', maxChars - 1);
      if (cut < maxChars / 2) cut = maxChars;
      out.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trim();
    }
    if (piece) out.push(piece);
  }
  return out.filter((piece) => piece.length >= MIN_SENTENCE_CHARS);
}
