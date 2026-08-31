import { describe, expect, it } from 'vitest';
import { BlockedAddressError, createOutboundFetch, isPublicAddress } from './outbound.js';

/**
 * The address classifier is the whole of the SSRF defence, so it is tested as a table rather than
 * by example. Every entry here is somewhere a webhook must never be able to reach.
 */
describe('isPublicAddress', () => {
  const privateAddresses = [
    '127.0.0.1',
    '127.53.1.9',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    // The one that matters most: the cloud instance metadata service.
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '192.0.0.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.7',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    // IPv4 wearing an IPv6 hat. Both spellings reach the same metadata service.
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '2002:a00:1::1',
    '64:ff9b::a00:1',
  ];

  for (const address of privateAddresses) {
    it(`refuses ${address}`, () => {
      expect(isPublicAddress(address)).toBe(false);
    });
  }

  const publicAddresses = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'];
  for (const address of publicAddresses) {
    it(`allows ${address}`, () => {
      expect(isPublicAddress(address)).toBe(true);
    });
  }

  it('refuses anything that is not an address at all', () => {
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('999.1.1.1')).toBe(false);
  });
});

describe('createOutboundFetch', () => {
  const send = createOutboundFetch();
  const request = { method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 };

  it('refuses a plain-http endpoint', async () => {
    await expect(send('http://example.com/hook', request)).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it('refuses a literal private address without asking a resolver', async () => {
    await expect(send('https://169.254.169.254/latest/meta-data/', request)).rejects.toThrow(
      /private address/,
    );
    await expect(send('https://127.0.0.1:9200/', request)).rejects.toThrow(/private address/);
    await expect(send('https://[::1]/', request)).rejects.toThrow(/private address/);
  });

  it('refuses a name that resolves into the private space', async () => {
    // localhost is the one name every machine resolves to a loopback address, which makes it the
    // portable way to prove that resolution - not just the text of the URL - is what is checked.
    await expect(send('https://localhost/hook', request)).rejects.toThrow(/private address/);
  });

  it('refuses a name that does not resolve', async () => {
    await expect(
      send('https://this-name-does-not-exist.invalid/hook', request),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('refuses something that is not a URL', async () => {
    await expect(send('not a url', request)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('allows plain http only where the deployment has opted in', async () => {
    const permissive = createOutboundFetch({ allowPrivateTargets: true });
    // Nothing is listening, so this fails at the socket - but it must get that far, which is the
    // difference between "refused by policy" and "the receiver was not there".
    await expect(permissive('http://127.0.0.1:9/hook', request)).rejects.not.toBeInstanceOf(
      BlockedAddressError,
    );
  });
});
