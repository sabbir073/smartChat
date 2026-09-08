import { describe, expect, it } from 'vitest';
import { onceJobId } from './producer.js';

/**
 * BullMQ throws "Custom Id cannot contain :" and the worker exits before it has scheduled
 * anything. That is what happened on the first deploy of the geo refresh, and a crash loop at
 * startup is the most expensive place to learn a library's rule.
 */
describe('onceJobId', () => {
  it('never contains a colon', () => {
    for (const key of ['geo-initial-load', 'geo:manual', 'a:b:c', 'x/y']) {
      expect(onceJobId(key)).not.toContain(':');
      expect(onceJobId(key)).not.toContain('/');
    }
  });

  it('is stable for the same key, so a duplicate request de-duplicates', () => {
    expect(onceJobId('geo-manual')).toBe(onceJobId('geo-manual'));
  });

  it('keeps distinct keys distinct', () => {
    expect(onceJobId('geo-manual')).not.toBe(onceJobId('geo-initial-load'));
  });
});
