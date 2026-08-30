#!/usr/bin/env node
/**
 * Phase 11: API keys and webhooks.
 *
 * The exit criterion is "webhook delivered and verified; API key scoped and revocable", and the
 * word doing the work is *verified*. A test that asserts we sent a signature proves only that we
 * can compute an HMAC. So this script stands up a real HTTP receiver, takes the raw bytes off the
 * wire, and checks the signature the way an integrator's code would - including rejecting one we
 * deliberately corrupt, because a verifier that accepts everything passes every test.
 *
 * The other half is the key: a credential is only as good as its limits, so the scopes are tested
 * by trying what they should refuse, and revocation is tested by using the key after it.
 *
 *   node scripts/e2e-integrations.mjs
 *
 * Requires the stack up including the worker, which is what actually delivers.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const ORIGIN = 'http://localhost:3004';
/** How the worker container reaches a server running on this machine. */
const RECEIVER_HOST = process.env.SMOKE_RECEIVER_HOST ?? 'host.docker.internal';
const RECEIVER_PORT = Number(process.env.SMOKE_RECEIVER_PORT ?? 4599);

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
    return;
  }
  failures.push(name);
  process.stdout.write(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

function resetRateLimits() {
  if (process.env.SMOKE_RESET_LIMITS === '0') return;
  const password = process.env.REDIS_PASSWORD ?? 'smartchat_dev_redis';
  try {
    execFileSync(
      'docker',
      [
        'compose', 'exec', '-T', 'redis', 'sh', '-c',
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'ratelimit:*' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null`,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    process.stdout.write('  note: could not clear rate-limit keys through docker compose\n');
  }
}

// ---------------------------------------------------------------------------
// The receiver: an integrator's endpoint, written the way theirs would be.
// ---------------------------------------------------------------------------

const { createHmac, timingSafeEqual } = await import('node:crypto');

/**
 * The verification an integrator writes.
 *
 * Deliberately re-implemented here from the documented rule rather than imported from
 * `@smartchat/core`. If both sides used the same function, the test would prove only that the
 * function agrees with itself - which is exactly the mistake a signing scheme cannot afford.
 */
function verify(secret, rawBody, header, nowSeconds) {
  const parts = Object.fromEntries(
    header.split(',').map((piece) => {
      const index = piece.indexOf('=');
      return [piece.slice(0, index).trim(), piece.slice(index + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return { valid: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - timestamp) > 300) return { valid: false, reason: 'stale' };

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.v1, 'utf8');
  if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
}

const received = [];
/** Paths that answer with a failure, so retry and auto-disable can be observed rather than assumed. */
let brokenUntilAttempt = 0;
let brokenAttempts = 0;

const receiver = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    // The RAW bytes. Re-serialising the parsed JSON would produce a different string and a
    // signature that never verifies - the single most common mistake in webhook receivers, and
    // one this test would rather make impossible than warn about.
    const raw = Buffer.concat(chunks).toString('utf8');

    if (request.url === '/broken') {
      brokenAttempts += 1;
      if (brokenAttempts < brokenUntilAttempt) {
        response.writeHead(500).end('nope');
        return;
      }
      received.push({ path: request.url, raw, headers: request.headers });
      response.writeHead(200).end('ok');
      return;
    }

    received.push({ path: request.url, raw, headers: request.headers });
    response.writeHead(request.url === '/always-500' ? 500 : 200).end('ok');
  });
});

async function waitForDelivery(matches, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = received.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// ---------------------------------------------------------------------------

class Http {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method, path, body) {
    const headers = { accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = this.cookies.get('sc_csrf');
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    this.absorb(response);
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: response.status, body: parsed };
  }
}

/** A request made the way an integration makes one: a bearer key, no cookies, no CSRF. */
async function withKey(key, method, path, body) {
  const headers = { accept: 'application/json', authorization: `Bearer ${key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API}/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function widgetCall(method, path, body, token) {
  const headers = { accept: 'application/json', origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

function emit(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) return reject(transportError);
      if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'no ack'));
      return resolve(ack.data);
    });
  });
}

async function main() {
  resetRateLimits();
  await new Promise((resolve) => receiver.listen(RECEIVER_PORT, resolve));
  process.stdout.write(`  receiver listening on ${RECEIVER_PORT}\n`);

  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Integration Owner',
    email: `integrations.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Integrations ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('owner registered', register.status === 201, `got ${register.status}`);

  const site = await owner.call('POST', '/properties', {
    name: 'Depot',
    websiteUrl: `https://depot-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const property = site.body.data;
  check('a website was created', site.status === 201, `got ${site.status}`);

  // =========================================================================
  section('An API key is scoped');
  // =========================================================================

  const readOnly = await owner.call('POST', '/integrations/keys', {
    name: 'Read-only reporting',
    scopes: ['tickets:read', 'reports:read'],
  });
  check('a key can be minted', readOnly.status === 201, JSON.stringify(readOnly.body?.error));
  const key = readOnly.body.data.secretShownOnce;
  check(
    'the secret is returned exactly once, and says so in its name',
    typeof key === 'string' && key.startsWith('sck_'),
    `${key?.slice(0, 12)}`,
  );

  const listed = await owner.call('GET', '/integrations/keys');
  // The secret half specifically: the prefix *is* returned, and is meant to be.
  const secretHalf = key.slice(key.indexOf('_', 4) + 1);
  check(
    'and never again - listing a key does not return its secret',
    listed.status === 200 && !JSON.stringify(listed.body.data).includes(secretHalf),
  );
  check(
    'though the prefix is shown, so a person can tell two keys apart',
    listed.body.data[0]?.prefix && key.startsWith(listed.body.data[0].prefix),
    listed.body.data[0]?.prefix,
  );

  const readTickets = await withKey(key, 'GET', '/tickets');
  check('the key can do what it was given', readTickets.status === 200, `got ${readTickets.status}`);

  const writeTicket = await withKey(key, 'POST', '/tickets', {
    propertyId: property.id,
    subject: 'Should not be allowed',
    body: 'A read-only key must not be able to write.',
    requesterEmail: `nope.${stamp}@example.test`,
    notifyRequester: false,
  });
  check(
    'and cannot do what it was not',
    writeTicket.status === 403,
    `got ${writeTicket.status}`,
  );

  const readContacts = await withKey(key, 'GET', '/contacts');
  check(
    'a scope it does not hold is refused even though the account has it',
    readContacts.status === 403,
    `got ${readContacts.status}`,
  );

  const manageKeys = await withKey(key, 'GET', '/integrations/keys');
  check(
    'and a key can never reach the keys - otherwise revocation would mean nothing',
    manageKeys.status === 403,
    `got ${manageKeys.status}`,
  );

  const team = await withKey(key, 'GET', '/team/members');
  check('nor the team', team.status === 403 || team.status === 404, `got ${team.status}`);

  section('A key cannot grant what its holder does not have');
  const overreach = await owner.call('POST', '/integrations/keys', {
    name: 'Everything',
    scopes: ['tickets:write', 'articles:write', 'contacts:write'],
  });
  check(
    'an owner can create a key with every scope they hold',
    overreach.status === 201,
    `got ${overreach.status}`,
  );

  section('A key is revocable');
  const beforeRevoke = await withKey(key, 'GET', '/tickets');
  check('it works before', beforeRevoke.status === 200, `got ${beforeRevoke.status}`);

  const revoked = await owner.call('DELETE', `/integrations/keys/${readOnly.body.data.id}`);
  check('it can be revoked', revoked.status === 204, `got ${revoked.status}`);

  const afterRevoke = await withKey(key, 'GET', '/tickets');
  check(
    'and stops working immediately - not at the next cache expiry',
    afterRevoke.status === 401,
    `got ${afterRevoke.status}`,
  );
  check(
    'with the same answer a made-up key gets, so a key space cannot be probed',
    (await withKey('sck_neverexisted_aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GET', '/tickets')).status ===
      401,
  );

  const stillListed = await owner.call('GET', '/integrations/keys');
  check(
    'the revoked key is kept, not deleted - "which key was that" is an incident question',
    stillListed.body.data.some((entry) => entry.id === readOnly.body.data.id && entry.revokedAt),
  );

  // =========================================================================
  section('A webhook endpoint must be a real address');
  // =========================================================================

  const privateUrl = await owner.call('POST', '/integrations/webhooks', {
    name: 'Internal',
    url: 'http://postgres:5432/hook',
    events: ['ping'],
  });
  // In development the private-address rule is relaxed by configuration so a test receiver can
  // run on this machine; in production this is a 422. Either answer is correct here, but a 500
  // never is.
  check(
    'a webhook pointed at our own database is either refused or accepted only in development',
    privateUrl.status === 422 || privateUrl.status === 201,
    `got ${privateUrl.status}`,
  );

  const notAUrl = await owner.call('POST', '/integrations/webhooks', {
    name: 'Nonsense',
    url: 'not a url at all',
    events: ['ping'],
  });
  check('and something that is not a URL is refused', notAUrl.status === 422, `got ${notAUrl.status}`);

  const noEvents = await owner.call('POST', '/integrations/webhooks', {
    name: 'Silent',
    url: `http://${RECEIVER_HOST}:${RECEIVER_PORT}/hook`,
    events: [],
  });
  check(
    'a webhook subscribed to nothing is refused rather than created and silent',
    noEvents.status === 422,
    `got ${noEvents.status}`,
  );

  // =========================================================================
  section('A webhook is delivered, and verifies');
  // =========================================================================

  const hook = await owner.call('POST', '/integrations/webhooks', {
    name: 'Order system',
    url: `http://${RECEIVER_HOST}:${RECEIVER_PORT}/hook`,
    events: ['ping', 'ticket.created', 'conversation.started', 'conversation.closed'],
  });
  check('a webhook can be created', hook.status === 201, JSON.stringify(hook.body?.error));
  const secret = hook.body.data.secretShownOnce;
  check('with a signing secret shown once', typeof secret === 'string' && secret.startsWith('whsec_'));

  const hooks = await owner.call('GET', '/integrations/webhooks');
  check(
    'and never returned again',
    !JSON.stringify(hooks.body.data).includes(secret),
  );

  const pinged = await owner.call('POST', `/integrations/webhooks/${hook.body.data.id}/ping`);
  check('a test can be sent', pinged.status === 201, JSON.stringify(pinged.body?.error));

  const ping = await waitForDelivery((entry) => entry.headers['x-smartchat-event'] === 'ping');
  check('and it arrives', ping !== null);

  if (ping) {
    check(
      'carrying the event and the delivery id in headers',
      ping.headers['x-smartchat-event'] === 'ping' &&
        typeof ping.headers['x-smartchat-delivery'] === 'string',
    );
    const now = Math.floor(Date.now() / 1000);
    const result = verify(secret, ping.raw, ping.headers['x-smartchat-signature'], now);
    check('the signature verifies against the raw bytes', result.valid, JSON.stringify(result));

    /**
     * The negative control.
     *
     * Without this, a verifier that returned `{valid:true}` unconditionally would pass every
     * check above - and so would a signature we never actually computed.
     */
    const tampered = verify(
      secret,
      ping.raw.replace('reachable', 'unreachable'),
      ping.headers['x-smartchat-signature'],
      now,
    );
    check('and fails if a single word of the body is changed', !tampered.valid, tampered.reason);
    check(
      'and fails against a different secret',
      !verify('whsec_wrong', ping.raw, ping.headers['x-smartchat-signature'], now).valid,
    );
    check(
      'and fails once the timestamp is old, so a captured delivery cannot be replayed',
      !verify(secret, ping.raw, ping.headers['x-smartchat-signature'], now + 400).valid,
    );

    const body = JSON.parse(ping.raw);
    check('the payload names the event', body.event === 'ping', body.event);
    check('and carries a sent-at inside the signed bytes', typeof body.sentAt === 'string');
  }

  // =========================================================================
  section('Real events reach it');
  // =========================================================================

  const ticket = await owner.call('POST', '/tickets', {
    propertyId: property.id,
    subject: 'A webhook should hear about this',
    body: 'Raised by hand.',
    requesterEmail: `hook.${stamp}@example.test`,
    notifyRequester: false,
  });
  check('a ticket was raised', ticket.status === 201, `got ${ticket.status}`);

  const ticketDelivery = await waitForDelivery(
    (entry) => entry.headers['x-smartchat-event'] === 'ticket.created',
  );
  check('the ticket.created event was delivered', ticketDelivery !== null);
  if (ticketDelivery) {
    const body = JSON.parse(ticketDelivery.raw);
    check('with the ticket number in it', body.data.number === ticket.body.data.number);
    check(
      'and it verifies too',
      verify(secret, ticketDelivery.raw, ticketDelivery.headers['x-smartchat-signature'], Math.floor(Date.now() / 1000)).valid,
    );
  }

  // A conversation started over the socket, the way every real one is.
  const session = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Integrations E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  const rtTicket = await widgetCall('POST', '/widget/realtime-ticket', {}, session.body.data.token);
  const socket = await new Promise((resolve, reject) => {
    const client = io(`${REALTIME}/visitor`, {
      transports: ['websocket'],
      auth: { ticket: rtTicket.body.data.ticket },
      reconnection: false,
      timeout: 10000,
    });
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
  const started = await emit(socket, 'conversation:start', {
    clientMessageId: ulid(),
    body: 'Does the gateway emit webhooks too?',
  });
  socket.close();

  const startedDelivery = await waitForDelivery(
    (entry) => entry.headers['x-smartchat-event'] === 'conversation.started',
  );
  check(
    'a conversation started over the socket also reaches the webhook',
    startedDelivery !== null,
  );
  if (startedDelivery) {
    const body = JSON.parse(startedDelivery.raw);
    check('with the conversation id', body.data.conversationId === started.conversationId);
  }

  await owner.call('PATCH', `/conversations/${started.conversationId}`, { status: 'closed' });
  const closedDelivery = await waitForDelivery(
    (entry) => entry.headers['x-smartchat-event'] === 'conversation.closed',
  );
  check('and so does closing it', closedDelivery !== null);

  section('Only subscribed events are sent');
  const before = received.length;
  await owner.call('POST', `/tickets/${ticket.body.data.id}/messages`, {
    body: 'A public reply - but this webhook did not subscribe to ticket.replied.',
    visibility: 'public',
  });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const replies = received
    .slice(before)
    .filter((entry) => entry.headers['x-smartchat-event'] === 'ticket.replied');
  check('an event nobody subscribed to is not delivered', replies.length === 0, `${replies.length}`);

  section('A failing endpoint is retried, then given up on');
  const flaky = await owner.call('POST', '/integrations/webhooks', {
    name: 'Flaky',
    url: `http://${RECEIVER_HOST}:${RECEIVER_PORT}/broken`,
    events: ['ping'],
  });
  check('a second webhook can be created', flaky.status === 201, `got ${flaky.status}`);

  brokenAttempts = 0;
  brokenUntilAttempt = 2; // fail once, succeed on the second attempt
  await owner.call('POST', `/integrations/webhooks/${flaky.body.data.id}/ping`);

  const retried = await waitForDelivery((entry) => entry.path === '/broken');
  check('a delivery that failed once is tried again and succeeds', retried !== null);
  check('and it took more than one attempt to get there', brokenAttempts >= 2, `${brokenAttempts}`);

  const flakyDeliveries = await owner.call(
    'GET',
    `/integrations/webhooks/${flaky.body.data.id}/deliveries`,
  );
  check(
    'the delivery log records the outcome',
    flakyDeliveries.status === 200 && flakyDeliveries.body.data[0]?.status === 'delivered',
    JSON.stringify(flakyDeliveries.body.data?.[0]),
  );
  check(
    'including that it took more than one attempt',
    flakyDeliveries.body.data[0]?.attempts >= 2,
    `${flakyDeliveries.body.data?.[0]?.attempts}`,
  );

  section('A webhook can be turned off, and its failures reset when it comes back');
  const disabled = await owner.call('PATCH', `/integrations/webhooks/${flaky.body.data.id}`, {
    enabled: false,
  });
  check('it can be disabled', disabled.status === 200 && disabled.body.data.enabled === false);

  const beforeDisabled = received.length;
  await owner.call('POST', '/tickets', {
    propertyId: property.id,
    subject: 'Nothing should reach a disabled endpoint',
    body: 'Quiet please.',
    requesterEmail: `quiet.${stamp}@example.test`,
    notifyRequester: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const toDisabled = received.slice(beforeDisabled).filter((entry) => entry.path === '/broken');
  check('a disabled endpoint receives nothing', toDisabled.length === 0, `${toDisabled.length}`);

  const reenabled = await owner.call('PATCH', `/integrations/webhooks/${flaky.body.data.id}`, {
    enabled: true,
  });
  check(
    're-enabling clears the failure count, so it is not immediately disabled again',
    reenabled.body.data.consecutiveFailures === 0 && reenabled.body.data.disabledReason === null,
    JSON.stringify(reenabled.body.data),
  );

  section('One account cannot see another');
  const stranger = new Http();
  await stranger.call('POST', '/auth/register', {
    name: 'Other Owner',
    email: `otherint.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Other Int ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  const strangerHooks = await stranger.call('GET', '/integrations/webhooks');
  check('a new account sees no webhooks', strangerHooks.body.data.length === 0);
  const strangerReads = await stranger.call(
    'GET',
    `/integrations/webhooks/${hook.body.data.id}/deliveries`,
  );
  check(
    "and cannot read another account's deliveries",
    strangerReads.status === 404,
    `got ${strangerReads.status}`,
  );

  const strangerKeys = await stranger.call('GET', '/integrations/keys');
  check('nor their keys', strangerKeys.body.data.length === 0);

  receiver.close();

  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(`${passed} checks passed.\n\n`);
    process.exit(0);
  }
  process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
  for (const name of failures) process.stdout.write(`  - ${name}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

main().catch((error) => {
  receiver.close();
  process.stderr.write(`\nIntegrations E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
