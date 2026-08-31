import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * The outbound HTTP client for addresses an account chose.
 *
 * A webhook URL is the one place in this product where a customer tells the server to make a
 * request on their behalf, which makes it a server-side request forgery primitive unless it is
 * fenced. The save-time schema (`webhookUrlSchema`) rejects the obvious targets, but a schema can
 * only look at text: `https://internal.example.com` is a perfectly public-looking name that can
 * resolve to 169.254.169.254 - and can resolve to something different tomorrow, or resolve twice
 * to two different answers. Validating the string is therefore necessary and not sufficient.
 *
 * So delivery re-checks at the level that actually matters, the address:
 *
 *  1. the URL is parsed and re-validated (https, unless this deployment allows private targets);
 *  2. the host is resolved, and **every** answer must be a public address - one private answer
 *     fails the whole request, because a resolver that returns two addresses will be asked twice;
 *  3. the socket is then pinned to those vetted addresses with a custom `lookup`, so the name is
 *     not resolved a second time between the check and the connection. That gap is the whole of
 *     DNS rebinding, and closing it is the reason this module exists rather than a bare `fetch`;
 *  4. redirects are not followed. `node:http` does not follow them on its own, which is exactly
 *     the behaviour we want: a 302 to the metadata service is a failed delivery, not a hop.
 *
 * The result is deliberately fetch-shaped so the service can be tested with a plain stub.
 */

export interface OutboundResponse {
  status: number;
  text: () => Promise<string>;
}

export interface OutboundRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type OutboundFetch = (url: string, request: OutboundRequest) => Promise<OutboundResponse>;

/** Raised when the target is refused before a byte leaves this process. */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 192 && b === 0) return false; // IETF protocol assignments and TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function ipv6IsPublic(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? '';
  if (value === '::1' || value === '::') return false;

  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a hat, and has to be
  // judged as one - `::ffff:169.254.169.254` is the metadata service.
  const embedded = value.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded?.[1]) return ipv4IsPublic(embedded[1]);

  if (/^f[cd]/.test(value)) return false; // unique local, fc00::/7
  if (/^fe[89ab]/.test(value)) return false; // link-local, fe80::/10
  if (/^ff/.test(value)) return false; // multicast
  if (value.startsWith('2002:')) return false; // 6to4 can tunnel to a private v4 address
  if (value.startsWith('64:ff9b:')) return false; // NAT64
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

interface Resolved {
  address: string;
  family: number;
}

async function resolvePublicAddresses(hostname: string): Promise<Resolved[]> {
  // A literal IP needs no resolver, and asking one would only introduce a second answer.
  const literal = net.isIP(hostname);
  if (literal !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new BlockedAddressError('The endpoint resolves to a private address');
    }
    return [{ address: hostname, family: literal }];
  }

  let answers: Resolved[];
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BlockedAddressError('The endpoint could not be resolved');
  }
  if (answers.length === 0) throw new BlockedAddressError('The endpoint could not be resolved');

  // Every answer, not the first: an attacker who controls the zone can return one public and one
  // private address and let the resolver pick. Any private answer fails the delivery.
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) {
      throw new BlockedAddressError('The endpoint resolves to a private address');
    }
  }
  return answers;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface OutboundFetchOptions {
  /**
   * Development only, and set from configuration rather than from any request. A test receiver
   * has to run somewhere, and in development that somewhere is this machine.
   */
  allowPrivateTargets?: boolean;
}

export function createOutboundFetch(options: OutboundFetchOptions = {}): OutboundFetch {
  const allowPrivate = options.allowPrivateTargets === true;

  return async function send(rawUrl, request) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BlockedAddressError('The endpoint is not a valid URL');
    }

    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
      throw new BlockedAddressError('Only https:// endpoints are delivered to');
    }

    const pinned = allowPrivate ? [] : await resolvePublicAddresses(url.hostname);

    // Hand the agent the addresses that were just vetted instead of letting it resolve the name
    // again. Without this the check above is advisory: the second lookup is a fresh opportunity
    // for the zone to answer differently.
    const lookup: LookupFunction = (_hostname, opts, callback) => {
      const all = typeof opts === 'object' && opts !== null && opts.all === true;
      if (all) {
        (callback as (err: null, addresses: Resolved[]) => void)(null, pinned);
        return;
      }
      const first = pinned[0];
      if (!first) {
        callback(new Error('no address'), '', 0);
        return;
      }
      callback(null, first.address, first.family);
    };

    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<OutboundResponse>((resolve, reject) => {
      const outgoing = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: { ...request.headers, host: url.host },
          timeout: request.timeoutMs,
          // Only when the addresses were vetted. In a development deployment that allows private
          // targets there is nothing to pin to, and the default resolver is correct.
          ...(allowPrivate ? {} : { lookup }),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;

          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            // A receiver that answers with a gigabyte should not be able to use our memory as
            // the place it lands. Past the cap the rest is dropped, not buffered.
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          });
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status, text: () => Promise.resolve(text) });
          });
          incoming.on('error', reject);
        },
      );

      outgoing.on('timeout', () => {
        outgoing.destroy(new Error('The endpoint did not respond in time'));
      });
      outgoing.on('error', reject);
      outgoing.end(request.body);
    });
  };
}
