import { describe, expect, it } from 'vitest';
import { checkingDelay, looksLikeLookup, usualFrom } from './reply.service.js';

/**
 * When the assistant says "give me a moment, I'm checking that for you".
 *
 * The bug these pin is a real one from production: the wait was a constant 4.5 seconds, chosen
 * when an answer was thought to take four to five. It actually takes about 6.4 seconds on that
 * machine, so the line went out before sixteen of seventeen answers - a courtesy that arrives
 * every single time is not a courtesy, it is noise, and that is exactly how the owner described
 * it.
 *
 * So the rule is no longer a constant. It is the owner's floor, and above that, "slower than this
 * website's own replies usually are". The numbers below are the real ones measured on
 * getchat.site (p50 6360 ms, p80 ≈ 7500 ms, p90 8133 ms, max 9018 ms).
 */

/** The live sample, near enough: what that machine's answers actually cost. */
const LIVE = [1264, 2842, 3441, 3533, 3985, 4370, 4576, 5210, 6170, 6360, 6527, 7100, 7400, 8133, 9018];

describe('usualFrom', () => {
  it('has no opinion until it has seen enough replies', () => {
    expect(usualFrom([])).toBeNull();
    expect(usualFrom([5000, 6000, 7000])).toBeNull();
    expect(usualFrom(Array.from({ length: 7 }, () => 6000))).toBeNull();
  });

  it('answers with the eightieth percentile once it has', () => {
    const eight = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
    expect(usualFrom(eight)).toBe(7000);
  });

  it('does not care what order the sample arrives in', () => {
    const shuffled = [...LIVE].reverse();
    expect(usualFrom(shuffled)).toBe(usualFrom(LIVE));
  });

  it('reads the live sample as about seven and a half seconds', () => {
    const usual = usualFrom(LIVE)!;
    expect(usual).toBeGreaterThan(7_000);
    expect(usual).toBeLessThan(8_500);
  });
});

describe('checkingDelay', () => {
  it('says nothing at all when the owner has switched the line off', () => {
    expect(checkingDelay({ afterSeconds: 0, usualReplyMs: 20_000 })).toBeNull();
  });

  it('never speaks before the owner floor, however fast the site is', () => {
    expect(checkingDelay({ afterSeconds: 10, usualReplyMs: 1_200 })).toBe(10_000);
  });

  it('waits past the floor on a site whose replies are simply slow', () => {
    // The live site: 7.5 s is normal there, so 10 s would still land in front of ordinary answers.
    const delay = checkingDelay({ afterSeconds: 10, usualReplyMs: usualFrom(LIVE)! })!;
    expect(delay).toBeGreaterThan(9_000);
    expect(delay).toBeGreaterThan(usualFrom(LIVE)!);
  });

  it('would have stayed quiet through almost every answer the live site has given', () => {
    const delay = checkingDelay({ afterSeconds: 10, usualReplyMs: usualFrom(LIVE)! })!;
    const spoken = LIVE.filter((latency) => latency > delay).length;
    // The old constant of 4500 ms spoke over nine of these fifteen; on the real answer-only
    // turns it was sixteen out of seventeen.
    expect(LIVE.filter((latency) => latency > 4_500).length).toBeGreaterThan(8);
    expect(spoken).toBe(0);
  });

  it('still speaks when an answer is genuinely slower than usual', () => {
    const delay = checkingDelay({ afterSeconds: 10, usualReplyMs: usualFrom(LIVE)! })!;
    // A fallback provider, a cold model, a long retrieval: the cases the line exists for.
    expect(18_000).toBeGreaterThan(delay);
  });

  it('falls back to the floor while the site has no history to judge by', () => {
    expect(checkingDelay({ afterSeconds: 10, usualReplyMs: null })).toBe(10_000);
  });
});

describe('looksLikeLookup', () => {
  it('still refuses to promise to check a greeting or a goodbye', () => {
    expect(looksLikeLookup('Hello there')).toBe(false);
    expect(looksLikeLookup('Thanks, that is all I needed - bye!')).toBe(false);
  });

  it('still recognises a real question', () => {
    expect(looksLikeLookup('How much does the Growth plan cost per month?')).toBe(true);
  });

  it('looks past a greeting or a filler in front of the question', () => {
    // What callers actually say first; the old rule heard "Hi" and promised nothing.
    expect(looksLikeLookup('Hi. What services does Smart Lab Global offer?')).toBe(true);
    expect(looksLikeLookup('Hello, how much does a website cost?')).toBe(true);
    expect(looksLikeLookup('Okay, so what are your opening hours?')).toBe(true);
    expect(looksLikeLookup('Assalamu alaikum, where is your office?')).toBe(true);
    expect(looksLikeLookup('Is it ok to pay by card?')).toBe(true);
  });

  it('counts a short Bengali question, which takes fewer words than English', () => {
    expect(looksLikeLookup('আপনাদের অফিস কোথায়?')).toBe(true);
    expect(looksLikeLookup('আপনারা কখন খোলা থাকেন')).toBe(true);
    expect(looksLikeLookup('হ্যালো, স্মার্ট ল্যাব গ্লোবাল কী কী সেবা দেয়?')).toBe(true);
  });

  it('still says nothing for greetings, thanks and small talk, in either language', () => {
    expect(looksLikeLookup('Hi, how are you?')).toBe(false);
    expect(looksLikeLookup('Okay')).toBe(false);
    expect(looksLikeLookup('Okay, thank you very much, goodbye')).toBe(false);
    expect(looksLikeLookup('হ্যালো')).toBe(false);
    expect(looksLikeLookup('ধন্যবাদ, আমার আর কিছু জানার নেই। বিদায়।')).toBe(false);
    expect(looksLikeLookup('আচ্ছা ঠিক আছে')).toBe(false);
  });
});
