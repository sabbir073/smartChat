import { describe, expect, it } from 'vitest';
import { classifyYesNo, extractEmail, isCancel, isFiller, normalise } from './classify.js';

describe('yes or no', () => {
  it.each([
    'yes',
    'Yes please',
    'yeah sure',
    'ok',
    'okay, go ahead',
    'do it',
    'create it please',
    'হ্যাঁ',
    'জি, করুন।',
    'ঠিক আছে',
    'অবশ্যই',
    'আচ্ছা',
  ])('reads "%s" as a yes', (text) => {
    expect(classifyYesNo(text)).toBe('yes');
  });

  it.each([
    'no',
    'Nope.',
    'not now',
    'no thanks',
    "don't",
    'না',
    'নাহ',
    'দরকার নেই',
    'লাগবে না',
    'থাক',
  ])('reads "%s" as a no', (text) => {
    expect(classifyYesNo(text)).toBe('no');
  });

  it('lets no win over yes', () => {
    expect(classifyYesNo('yes... no, not now')).toBe('no');
  });

  it('takes a long answer only when it opens with the word', () => {
    expect(classifyYesNo('no, actually I wanted to ask about delivery to Sylhet')).toBe('no');
    expect(classifyYesNo('yes and also can you tell me the opening hours')).toBe('yes');
    expect(classifyYesNo('I think the delivery was supposed to be yes terday')).toBe('unclear');
  });

  it('does not mistake a question that starts with a filler for a yes', () => {
    expect(classifyYesNo('ok so what are your opening hours')).toBe('unclear');
    expect(classifyYesNo('please tell me your opening hours')).toBe('unclear');
    expect(classifyYesNo("I don't know my order number")).toBe('unclear');
  });

  it('is unclear about anything else', () => {
    expect(classifyYesNo('what does a ticket mean')).toBe('unclear');
    expect(classifyYesNo('')).toBe('unclear');
    expect(classifyYesNo('আমার অর্ডার কোথায়')).toBe('unclear');
  });
});

describe('cancel', () => {
  it('recognises the words that abandon a ticket', () => {
    expect(isCancel('cancel')).toBe(true);
    expect(isCancel('no, cancel that')).toBe(true);
    expect(isCancel('না')).toBe(true);
    expect(isCancel('থাক')).toBe(true);
    expect(isCancel('my email is ana at example dot com')).toBe(false);
  });
});

describe('filler', () => {
  it.each([
    'hello',
    'Hello?',
    'hi',
    'ok',
    'okay okay',
    'hmm',
    'yes',
    'yeah',
    'right',
    'thanks',
    'thank you',
    'আচ্ছা',
    'হ্যালো',
    'ঠিক আছে',
    'জি',
    'হুম',
    'আছেন?',
    'হ্যাঁ হ্যাঁ',
  ])('treats "%s" as filler', (text) => {
    expect(isFiller(text)).toBe(true);
  });

  it.each([
    'hello I have a question',
    'where is my order',
    'yes but what about saturday',
    'আমার অর্ডার কোথায়',
  ])('does not treat "%s" as filler', (text) => {
    expect(isFiller(text)).toBe(false);
  });

  it('treats nothing as filler', () => {
    expect(isFiller('   ')).toBe(true);
  });
});

describe('normalise', () => {
  it('keeps Bengali vowel signs', () => {
    expect(normalise('করুন।')).toBe('করুন');
    expect(normalise('ঠিক আছে!')).toBe('ঠিক আছে');
  });
});

describe('email', () => {
  it('finds the address in a chat message and lower-cases it', () => {
    expect(extractEmail('My email: Ana.Rahman+shop@Example.co.uk thanks')).toBe(
      'ana.rahman+shop@example.co.uk',
    );
  });

  it('finds nothing in words', () => {
    expect(extractEmail('ana at example dot com')).toBeNull();
    expect(extractEmail('')).toBeNull();
  });
});
