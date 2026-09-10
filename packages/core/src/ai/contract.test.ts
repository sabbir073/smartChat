import { describe, expect, it } from 'vitest';
import { cleanText, cleanTopic, MAX_REPLY_CHARS, parseReply, parseSuggestions } from './contract.js';
import { looksLikeLookup } from './reply.service.js';

const options = { passageCount: 3, allowedHosts: ['acmebikes.example'] };

describe('parseReply', () => {
  it('accepts a well-formed answer that cites a passage', () => {
    const result = parseReply('{"decision":"answer","text":"Two years.","sources":[2]}', options);
    expect(result).toEqual({ ok: true, reply: { decision: 'answer', text: 'Two years.', sources: [2], urgent: false, goodbye: false, topic: '' } });
  });

  /**
   * The operator's rule: what the AI does not know, it does not guess. A confident answer with
   * nothing behind it is exactly the guess, and it becomes the ticket offer.
   */
  it('downgrades an answer that cites nothing to a ticket', () => {
    const result = parseReply('{"decision":"answer","text":"We only sell bikes.","sources":[]}', options);
    expect(result).toMatchObject({ ok: true, reply: { decision: 'ticket', text: '', sources: [] }, downgraded: expect.any(String) });
  });

  it('drops citations to passages that were not in the prompt', () => {
    const result = parseReply('{"decision":"answer","text":"Yes.","sources":[1, 7, 1, -2]}', options);
    expect(result).toMatchObject({ ok: true, reply: { sources: [1] } });
  });

  it('keeps the decision but not the words for a ticket or a handoff', () => {
    const ticket = parseReply('{"decision":"ticket","text":"I cannot check orders.","sources":[1]}', options);
    expect(ticket).toMatchObject({ ok: true, reply: { decision: 'ticket', text: '', sources: [] } });
    const human = parseReply('{"decision":"human","text":"Sure","sources":[]}', options);
    expect(human).toMatchObject({ ok: true, reply: { decision: 'human', text: '', sources: [] } });
  });

  /** "Hello" deserves "Hello": a chat reply is the model's own words and needs no passage. */
  it('lets a chat reply through uncited, but not an empty one', () => {
    expect(parseReply('{"decision":"chat","text":"Hello! How can I help?","sources":[]}', options)).toMatchObject({
      ok: true,
      reply: { decision: 'chat', text: 'Hello! How can I help?', sources: [] },
    });
    expect(parseReply('{"decision":"chat","text":"","sources":[]}', options)).toMatchObject({
      ok: true,
      reply: { decision: 'ticket' },
    });
  });

  it('tolerates a code fence around the JSON', () => {
    const raw = '```json\n{"decision":"answer","text":"Ok","sources":[3]}\n```';
    expect(parseReply(raw, options)).toMatchObject({ ok: true, reply: { decision: 'answer', sources: [3] } });
  });

  it('refuses anything that is not the contract', () => {
    expect(parseReply('The warranty is two years.', options).ok).toBe(false);
    expect(parseReply('{"decision":"refund","text":"x","sources":[]}', options).ok).toBe(false);
    expect(parseReply('{"text":"x"}', options).ok).toBe(false);
  });

  /**
   * Rule 8 of the prompt, enforced: a number the passages do not contain was invented. Measured
   * on the production model, the leak was real - asked for hours it did not have, it answered
   * with the practice shop's "Monday to Friday, 9 to 5" and cited passage 1.
   */
  describe('grounding', () => {
    const grounded = {
      ...options,
      grounding: [
        'Shipping is free on orders above 5,000 BDT, otherwise 120 BDT inside Dhaka and 200 BDT elsewhere. Orders arrive in 1-2 business days.',
        'Open Saturday to Thursday, 10:00 to 20:00. Phone +880 1711-000000.',
        'Where is my order 4471?',
      ],
      practicePhrases: ['Monday to Friday, 9 to 5', '9 to 5', 'Kenya', 'Mombasa', 'KES'],
    };

    it('keeps an answer whose numbers all come from the passages, however they are written', () => {
      const raw = '{"decision":"answer","text":"Free above 5000 BDT, else 200 BDT; 1-2 days. Call +8801711000000 between 10:00 and 20:00.","sources":[1]}';
      expect(parseReply(raw, grounded)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });

    it('reads Bengali numerals as the same numbers', () => {
      const raw = '{"decision":"answer","text":"৫,০০০ টাকার উপরে ফ্রি, নাহলে ২০০ টাকা।","sources":[1]}';
      expect(parseReply(raw, grounded)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });

    it('turns an answer with an invented number into the ticket offer', () => {
      const raw = '{"decision":"answer","text":"Shipping is 150 BDT everywhere.","sources":[1]}';
      expect(parseReply(raw, grounded)).toMatchObject({
        ok: true,
        reply: { decision: 'ticket', text: '' },
        downgraded: expect.stringContaining('150'),
      });
    });

    it('lets a number from the visitor\'s own question through', () => {
      const raw = '{"decision":"answer","text":"Order 4471 ships in 1-2 business days.","sources":[1]}';
      expect(parseReply(raw, grounded)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });

    it('ignores list numbering', () => {
      const raw = '{"decision":"answer","text":"1. Free above 5,000 BDT\\n2. Otherwise 200 BDT","sources":[1]}';
      expect(parseReply(raw, grounded)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });

    it('refuses the practice shop\'s facts, as an answer or as chat', () => {
      const answer = '{"decision":"answer","text":"We are open Monday to Friday, 9 to 5.","sources":[2]}';
      expect(parseReply(answer, grounded)).toMatchObject({
        ok: true,
        reply: { decision: 'ticket' },
        downgraded: expect.stringContaining('practice'),
      });
      const chat = '{"decision":"chat","text":"We deliver anywhere in Kenya!","sources":[]}';
      expect(parseReply(chat, grounded)).toMatchObject({ ok: true, reply: { decision: 'ticket' } });
    });

    it('matches practice phrases as whole words and allows them when a passage has them', () => {
      const bikes = '{"decision":"chat","text":"We love bikes here!","sources":[]}';
      expect(parseReply(bikes, grounded)).toMatchObject({ ok: true, reply: { decision: 'chat' } });
      const kenyan = { ...grounded, grounding: [...grounded.grounding, 'We ship to Kenya and Uganda.'] };
      const raw = '{"decision":"answer","text":"Yes, we ship to Kenya.","sources":[1]}';
      expect(parseReply(raw, kenyan)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });

    it('skips the number check when no grounding is given', () => {
      const raw = '{"decision":"answer","text":"Shipping is 150 BDT.","sources":[1]}';
      expect(parseReply(raw, options)).toMatchObject({ ok: true, reply: { decision: 'answer' } });
    });
  });
});

describe('signals and topic', () => {
  it('carries urgent, goodbye and a cleaned topic through', () => {
    const raw = '{"decision":"chat","text":"Bye!","sources":[],"urgent":true,"goodbye":true,"topic":"Delivery, Times!"}';
    expect(parseReply(raw, options)).toMatchObject({ ok: true, reply: { urgent: true, goodbye: true, topic: 'delivery times' } });
  });

  it('turns a generic or absent topic into nothing, and keeps two words at most', () => {
    expect(cleanTopic('General')).toBe('');
    expect(cleanTopic('')).toBe('');
    expect(cleanTopic('Refund for a broken frame please')).toBe('refund for');
    expect(cleanTopic('ভর্তি ফি')).toBe('ভর্তি ফি');
    expect(cleanTopic('what warranty')).toBe('warranty');
    expect(cleanTopic('the fees')).toBe('fees');
  });
});

describe('parseSuggestions', () => {
  const grounded = {
    ...options,
    grounding: ['Shipping is free above 5,000 BDT.'],
    practicePhrases: ['Kenya', '9 to 5'],
  };

  it('keeps a cited, grounded answer and the two soft kinds, three at most', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'answer', text: 'Shipping is free above 5,000 BDT.', sources: [1] },
        { kind: 'clarify', text: 'Which city are you in?', sources: [] },
        { kind: 'acknowledge', text: 'Thanks for asking - let me check.', sources: [2] },
        { kind: 'clarify', text: 'One more?', sources: [] },
      ],
    });
    const out = parseSuggestions(raw, grounded);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'answer', text: 'Shipping is free above 5,000 BDT.', sources: [1] });
    // Only an answer carries sources; the model's citation on a reassurance is noise.
    expect(out[2]?.sources).toEqual([]);
  });

  /** A person sends these with one click, so an ungrounded "answer" is dropped, not softened. */
  it('drops an answer that cites nothing, invents a number, or repeats the practice shop', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'answer', text: 'We only ship on Mondays.', sources: [] },
        { kind: 'answer', text: 'Shipping costs 150 BDT.', sources: [1] },
        { kind: 'answer', text: 'We deliver anywhere in Kenya.', sources: [1] },
        { kind: 'clarify', text: 'Could you share your order number?', sources: [] },
      ],
    });
    expect(parseSuggestions(raw, grounded)).toEqual([{ kind: 'clarify', text: 'Could you share your order number?', sources: [] }]);
  });

  it('dedupes, ignores empty text, and returns nothing for garbage', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'clarify', text: 'Which size?', sources: [] },
        { kind: 'clarify', text: 'which size?', sources: [] },
        { kind: 'acknowledge', text: '   ', sources: [] },
      ],
    });
    expect(parseSuggestions(raw, grounded)).toHaveLength(1);
    expect(parseSuggestions('not json', grounded)).toEqual([]);
    expect(parseSuggestions('{"suggestions":"no"}', grounded)).toEqual([]);
  });
});

describe('cleanText', () => {
  it('strips markup and control characters', () => {
    expect(cleanText('Hello <b>there</b>  friend', [])).toBe('Hello there friend');
  });

  /**
   * A passage that was tampered with could ask the assistant to send visitors to a look-alike
   * site. Links survive only when they point at the account's own domains.
   */
  it('removes links to hosts the account does not own', () => {
    const text = 'See https://acmebikes.example/returns or https://evil.example/login now';
    expect(cleanText(text, ['acmebikes.example'])).toBe('See https://acmebikes.example/returns or now');
    expect(cleanText('Go to https://shop.acmebikes.example/x', ['acmebikes.example'])).toContain('shop.acmebikes.example');
  });

  it('cuts an essay at a sentence boundary', () => {
    const text = `${'A sentence that goes on. '.repeat(80)}`;
    const out = cleanText(text, []);
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out.endsWith('.')).toBe(true);
  });
});

describe('looksLikeLookup', () => {
  it('treats greetings, thanks and one-word answers as not worth a holding message', () => {
    expect(looksLikeLookup('Hello there')).toBe(false);
    expect(looksLikeLookup('Thanks, that is all. Bye!')).toBe(false);
    expect(looksLikeLookup('yes')).toBe(false);
    expect(looksLikeLookup('Great, thanks, that is all I needed. Bye!')).toBe(false);
    expect(looksLikeLookup('Hi, do you deliver to Sylhet and how much does it cost for a bike?')).toBe(true);
    expect(looksLikeLookup('How much is delivery to Sylhet?')).toBe(true);
    expect(looksLikeLookup('ভর্তি ফি কত টাকা এবং কখন?')).toBe(true);
  });
});
