import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_RETRIES_PER_REQUEST, buildRedisOptions } from './client.js';

const url = 'redis://localhost:6379';

describe('buildRedisOptions', () => {
  it('applies the default retry count when none is given', () => {
    expect(buildRedisOptions({ url }).maxRetriesPerRequest).toBe(DEFAULT_MAX_RETRIES_PER_REQUEST);
  });

  /**
   * BullMQ refuses to construct a Worker unless this is exactly `null`. An earlier version used
   * `options.maxRetriesPerRequest ?? 3`, which turned the explicit null back into 3 and left the
   * worker dead on startup with no other symptom.
   */
  it('preserves an explicit null, which BullMQ requires for blocking connections', () => {
    expect(buildRedisOptions({ url, maxRetriesPerRequest: null }).maxRetriesPerRequest).toBeNull();
  });

  it('preserves an explicit zero', () => {
    expect(buildRedisOptions({ url, maxRetriesPerRequest: 0 }).maxRetriesPerRequest).toBe(0);
  });

  it('preserves an explicit false for enableReadyCheck', () => {
    expect(buildRedisOptions({ url, enableReadyCheck: false }).enableReadyCheck).toBe(false);
    expect(buildRedisOptions({ url }).enableReadyCheck).toBe(true);
  });

  it('omits keyPrefix entirely rather than setting an empty string', () => {
    expect(buildRedisOptions({ url })).not.toHaveProperty('keyPrefix');
    expect(buildRedisOptions({ url, keyPrefix: 'sc:' }).keyPrefix).toBe('sc:');
  });

  it('caps reconnect backoff so an outage cannot become a reconnect storm', () => {
    const strategy = buildRedisOptions({ url }).retryStrategy;
    expect(typeof strategy).toBe('function');
    expect(strategy?.(1)).toBe(200);
    expect(strategy?.(10)).toBe(2000);
    expect(strategy?.(1000)).toBe(5000);
  });
});
