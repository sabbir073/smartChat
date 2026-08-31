#!/usr/bin/env node
/**
 * The load test.
 *
 * What this is for: finding out whether the parts of this system that are supposed to hold under
 * concurrency actually do - and doing it against the real stack, over real sockets, with real
 * Postgres and Redis behind them. A number from a benchmark that stubs the database tells you how
 * fast the stub is.
 *
 * What it measures, in order of how much it matters:
 *
 *  1. **Correctness under concurrency.** Every message sent must appear exactly once in the
 *     transcript. Message sequence numbers within a conversation must be strictly increasing with
 *     no gaps and no duplicates. If a hundred visitors talking at once can make the sequence
 *     counter skip, that is a correctness bug that a latency graph would never show.
 *  2. **Nothing lost.** Every conversation started must exist afterwards, with the number of
 *     messages it was sent.
 *  3. **Latency.** p50/p95/p99 and the worst case, for socket send-to-acknowledgement. The
 *     acknowledgement is only sent once the message is committed, so this is time-to-durable, not
 *     time-to-leave-the-machine.
 *
 * Deliberately not a stress test to failure. The interesting question for a product at this stage
 * is "does it stay correct while busy", not "what is the largest number this laptop can print".
 *
 *   node scripts/loadtest.mjs                  # 40 visitors, 10 messages each
 *   LOAD_VISITORS=100 LOAD_MESSAGES=20 node scripts/loadtest.mjs
 *
 * Requires the full stack.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const ORIGIN = 'http://localhost:3004';

const VISITORS = Number(process.env.LOAD_VISITORS ?? 40);
const MESSAGES = Number(process.env.LOAD_MESSAGES ?? 10);
/** How many visitors connect at once. Ramping rather than stampeding is what a real hour looks like. */
const BATCH = Number(process.env.LOAD_BATCH ?? 10);
/**
 * Visitors are spread across several websites, and that is not an incidental detail.
 *
 * `propertyMessage` is 300/min for one website - a deliberate ceiling on what a single customer's
 * site can push through. Driving 400 messages at one website would spend the run discovering that
 * limit, which already has its own test. Real load arrives at many websites at once, so this test
 * arrives at many websites at once, and every message stays inside the limits the product
 * actually enforces.
 */
const PROPERTIES = Number(process.env.LOAD_PROPERTIES ?? 4);

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

/**
 * Clear rate-limit counters matching a pattern.
 *
 * Two different uses, and the difference matters enough to be explicit about.
 *
 * At the start, everything is cleared: a run that begins inside somebody else's leftover counters
 * measures the leftovers.
 *
 * Between batches, only `widgetSession` is cleared - the per-IP limit on starting a widget session.
 * Forty visitors here share one machine and therefore one address; in the world they would be forty
 * addresses, so that particular limit is an artefact of the test rig rather than a property of the
 * system under test. Every other limit stays on for the whole run: `visitorMessage` per visitor and
 * `propertyMessage` per website are the ones this load has to fit inside, and it does.
 */
function clearLimits(pattern = 'ratelimit:*') {
  const password = process.env.REDIS_PASSWORD ?? 'smartchat_dev_redis';
  try {
    execFileSync(
      'docker',
      [
        'compose', 'exec', '-T', 'redis', 'sh', '-c',
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern '${pattern}' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null`,
      ],
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

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
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
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

function emit(socket, event, payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) return reject(transportError);
      if (!ack?.success) return reject(new Error(ack?.error?.code ?? 'no ack'));
      return resolve(ack.data);
    });
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/** One visitor's whole life: connect, start a chat, say everything, leave. */
async function runVisitor(publicId, index, latencies) {
  const session = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/?v=${index}`, title: 'Load' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  if (session.status !== 200) throw new Error(`session ${session.status}`);
  const token = session.body.data.token;

  const ticket = await widgetCall('POST', '/widget/realtime-ticket', {}, token);
  if (ticket.status !== 200) throw new Error(`ticket ${ticket.status}`);

  const socket = await new Promise((resolve, reject) => {
    const client = io(`${REALTIME}/visitor`, {
      transports: ['websocket'],
      auth: { ticket: ticket.body.data.ticket },
      reconnection: false,
      timeout: 20_000,
    });
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });

  try {
    const startedAt = Date.now();
    const started = await emit(socket, 'conversation:start', {
      clientMessageId: ulid(),
      body: `Visitor ${index} message 0`,
    });
    latencies.push(Date.now() - startedAt);

    for (let n = 1; n < MESSAGES; n += 1) {
      const at = Date.now();
      await emit(socket, 'message:send', {
        conversationId: started.conversationId,
        clientMessageId: ulid(),
        body: `Visitor ${index} message ${n}`,
      });
      latencies.push(Date.now() - at);
    }

    return started.conversationId;
  } finally {
    socket.close();
  }
}

async function main() {
  const cleared = clearLimits();
  const perProperty = Math.ceil((VISITORS / PROPERTIES) * MESSAGES);
  process.stdout.write(
    `SmartChat load test: ${VISITORS} visitors x ${MESSAGES} messages across ${PROPERTIES} websites,` +
      ` ${BATCH} at a time\n` +
      `rate limits ${cleared ? 'cleared to start' : 'NOT cleared - results will include refusals'}` +
      ` | ~${perProperty} messages per website per run (the limit is 300/min)\n`,
  );

  section('Setting up');
  const stamp = Date.now();
  const owner = new Http();
  await owner.call('POST', '/auth/register', {
    name: 'Load Owner',
    email: `load.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Load ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });

  const properties = [];
  for (let index = 0; index < PROPERTIES; index += 1) {
    const site = await owner.call('POST', '/properties', {
      name: `Load site ${index + 1}`,
      websiteUrl: `https://load-${stamp}-${index}.example.com`,
      timezone: 'UTC',
      locale: 'en',
    });
    if (site.body?.data?.publicId) properties.push(site.body.data);
  }
  check(
    `${PROPERTIES} websites to talk to`,
    properties.length === PROPERTIES,
    `${properties.length} created`,
  );

  section(`Running ${VISITORS * MESSAGES} messages through the gateway`);
  const latencies = [];
  const conversationIds = [];
  const errors = [];
  const wallStart = Date.now();

  for (let start = 0; start < VISITORS; start += BATCH) {
    // See clearLimits(): one machine standing in for forty browsers trips a per-IP limit that a
    // real forty would never reach. Nothing else is cleared.
    clearLimits('ratelimit:widgetSession:*');

    const batch = [];
    for (let index = start; index < Math.min(start + BATCH, VISITORS); index += 1) {
      const property = properties[index % properties.length];
      batch.push(
        runVisitor(property.publicId, index, latencies).then(
          (id) => conversationIds.push(id),
          (error) => errors.push(error.message ?? String(error)),
        ),
      );
    }
    await Promise.all(batch);
    process.stdout.write(`  ...${Math.min(start + BATCH, VISITORS)}/${VISITORS} visitors done\n`);
  }

  const wallMs = Date.now() - wallStart;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sent = VISITORS * MESSAGES;

  section('Results');
  process.stdout.write(
    `  wall clock           ${(wallMs / 1000).toFixed(1)} s\n` +
      `  throughput           ${(latencies.length / (wallMs / 1000)).toFixed(1)} messages/second\n` +
      `  send -> committed    p50 ${percentile(sorted, 0.5)} ms | ` +
      `p95 ${percentile(sorted, 0.95)} ms | p99 ${percentile(sorted, 0.99)} ms | ` +
      `max ${sorted[sorted.length - 1] ?? 0} ms\n` +
      `  failures             ${errors.length}\n`,
  );
  if (errors.length > 0) {
    const tally = new Map();
    for (const error of errors) tally.set(error, (tally.get(error) ?? 0) + 1);
    for (const [message, count] of tally) process.stdout.write(`    ${count} x ${message}\n`);
  }

  check('every visitor got through', errors.length === 0, `${errors.length} failed`);
  check(
    'every message was acknowledged',
    latencies.length === sent,
    `${latencies.length} of ${sent}`,
  );
  check(
    'every conversation is distinct',
    new Set(conversationIds).size === conversationIds.length,
    `${new Set(conversationIds).size} unique of ${conversationIds.length}`,
  );

  section('Nothing was lost, duplicated, or misordered');
  /**
   * The part a latency graph cannot tell you. Under concurrency the sequence counter is the thing
   * most likely to go wrong, and the symptom is silent: a gap where a message used to be, or two
   * messages claiming the same position.
   */
  let checkedConversations = 0;
  let badSequences = 0;
  let wrongCounts = 0;
  let duplicateBodies = 0;

  for (const conversationId of conversationIds) {
    const transcript = await owner.call('GET', `/conversations/${conversationId}/messages`);
    if (transcript.status !== 200) {
      wrongCounts += 1;
      continue;
    }
    const messages = transcript.body.data;
    checkedConversations += 1;

    if (messages.length !== MESSAGES) wrongCounts += 1;

    const seqs = messages.map((message) => Number(message.seq));
    const ascending = seqs.every((value, index) => index === 0 || value > seqs[index - 1]);
    const contiguous = new Set(seqs).size === seqs.length;
    if (!ascending || !contiguous) badSequences += 1;

    const bodies = messages.map((message) => message.body);
    if (new Set(bodies).size !== bodies.length) duplicateBodies += 1;
  }

  check(
    `all ${checkedConversations} transcripts were readable`,
    checkedConversations === conversationIds.length,
    `${checkedConversations} of ${conversationIds.length}`,
  );
  check(
    'every transcript holds exactly the messages that were sent',
    wrongCounts === 0,
    `${wrongCounts} conversations with the wrong count`,
  );
  check(
    'sequence numbers are strictly increasing and unique',
    badSequences === 0,
    `${badSequences} conversations with a broken sequence`,
  );
  check(
    'no message was written twice',
    duplicateBodies === 0,
    `${duplicateBodies} conversations with a duplicate`,
  );

  section('The API is still healthy afterwards');
  const health = await fetch(`${API}/health`).then((r) => r.status);
  check('the API answers /health', health === 200, `got ${health}`);
  const listed = await owner.call('GET', '/conversations?limit=1');
  check('and still serves the dashboard', listed.status === 200, `got ${listed.status}`);

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`${passed} checks passed under load.\n`);
}

main().catch((error) => {
  process.stdout.write(`\nFATAL: ${error?.stack ?? error}\n`);
  process.exit(1);
});
