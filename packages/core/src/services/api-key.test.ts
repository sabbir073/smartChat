import { describe, expect, it } from 'vitest';
import { splitApiKey } from './api-key.service.js';

/**
 * The regression this file exists for.
 *
 * The first implementation split a presented key at `lastIndexOf('_')`. API key secrets are
 * base64url, which includes `_` and `-`, so for roughly half of all keys the split landed inside
 * the secret: the prefix lookup missed, and the key returned 401. It authenticated perfectly in
 * the cases that happened not to contain an underscore, which is the worst kind of intermittent.
 *
 * Every case below fixes a secret shape by hand rather than generating one, because a random
 * secret reproduces this bug only half the time - and a test that fails half the time is a test
 * people learn to re-run.
 */
const PREFIX = 'sck_a1b2c3d4e5f6';

describe('splitApiKey', () => {
  it('splits a plain secret', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyz012345';
    expect(splitApiKey(`${PREFIX}_${secret}`)).toEqual({ prefix: PREFIX, secret });
  });

  it('splits a secret containing underscores', () => {
    const secret = 'abc_defghij_klmnopqrstuvwxyz_012';
    expect(splitApiKey(`${PREFIX}_${secret}`)).toEqual({ prefix: PREFIX, secret });
  });

  it('splits a secret ending in an underscore', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyz01234_';
    expect(splitApiKey(`${PREFIX}_${secret}`)).toEqual({ prefix: PREFIX, secret });
  });

  it('splits a secret containing hyphens, which base64url also produces', () => {
    const secret = 'abc-def_ghi-jklmnopqrstuvwxyz012';
    expect(splitApiKey(`${PREFIX}_${secret}`)).toEqual({ prefix: PREFIX, secret });
  });

  it('refuses anything that is not one of our keys', () => {
    const cases = [
      '',
      'sck_',
      'sck_short_abc',
      'notsck_a1b2c3d4e5f6_abcdefghijklmnopqrstuvwxyz012345',
      // A prefix that is the right length but not hex: not something we ever issued.
      'sck_ZZZZZZZZZZZZ_abcdefghijklmnopqrstuvwxyz012345',
      // The right shape, but the secret is too short to be one of ours.
      'sck_a1b2c3d4e5f6_tooshort',
    ];
    for (const value of cases) {
      expect(splitApiKey(value), value).toBeNull();
    }
  });

  it('does not treat a session-style bearer token as a key', () => {
    expect(splitApiKey('v1.abcdefghijklmnop.qrstuvwxyz')).toBeNull();
  });
});
