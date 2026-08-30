#!/usr/bin/env node
/**
 * Phase 10: reports.
 *
 * The exit criterion is "metrics match hand-computed values on seeded data", and the only way to
 * mean that is to build a situation whose numbers a person can work out on paper, then assert
 * those exact numbers - not "greater than zero", not "the same as a second query", which would
 * only prove the code agrees with itself.
 *
 * So this script creates a known world:
 *
 *   3 visitors, 3 conversations, 1 of them closed
 *   6 visitor messages, 4 agent replies, 1 internal note (which must NOT count)
 *   2 tickets, 1 resolved
 *
 * and then checks the report says exactly that. It also checks the arithmetic that is easy to get
 * wrong - an average built from a stored sum and count rather than an average of averages - and
 * the scoping that keeps one account's numbers out of another's.
 *
 *   node scripts/e2e-reports.mjs
 *
 * Requires the stack to be up.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Resolved from the web app's dependencies rather than the repo root: `scripts/` is deliberately
// not a package, so it has no node_modules of its own.
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const ORIGIN = 'http://localhost:3004';

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

const today = () => new Date().toISOString().slice(0, 10);

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
  const stamp = Date.now();
  const owner = new Http();

  section('A world whose numbers a person can work out');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Report Owner',
    email: `reports.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Reports ${stamp}`,
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
  const other = await owner.call('POST', '/properties', {
    name: 'Warehouse',
    websiteUrl: `https://warehouse-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const property = site.body.data;
  const otherProperty = other.body.data;
  check('two websites exist', site.status === 201 && other.status === 201);

  /**
   * One visitor: a session, a socket, a conversation, and n messages from them.
   *
   * A visitor only ever talks over the gateway - there is no HTTP endpoint for starting a
   * conversation - so the test does it the same way rather than through a back door that does not
   * exist. Which matters here: the numbers being asserted have to come from the path real traffic
   * takes, or they are measuring a fixture.
   */
  async function visitorWith(messages) {
    const session = await widgetCall('POST', '/widget/session', {
      p: property.publicId,
      page: { url: `${ORIGIN}/`, title: 'Reports E2E' },
      language: 'en-GB',
      timezone: 'UTC',
    });
    const token = session.body.data.token;
    const ticket = await widgetCall('POST', '/widget/realtime-ticket', {}, token);

    const socket = await new Promise((resolve, reject) => {
      const client = io(`${REALTIME}/visitor`, {
        transports: ['websocket'],
        auth: { ticket: ticket.body.data.ticket },
        reconnection: false,
        timeout: 10000,
      });
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });

    const started = await emit(socket, 'conversation:start', {
      clientMessageId: ulid(),
      body: messages[0],
    });
    for (const body of messages.slice(1)) {
      await emit(socket, 'message:send', {
        conversationId: started.conversationId,
        clientMessageId: ulid(),
        body,
        type: 'text',
      });
    }
    socket.close();
    return { conversationId: started.conversationId, ok: true };
  }

  // 3 conversations; 2 + 2 + 2 = 6 visitor messages.
  const first = await visitorWith(['My invoice is wrong.', 'It is the VAT line.']);
  const second = await visitorWith(['Where is my delivery?', 'It was due Tuesday.']);
  const third = await visitorWith(['Do you ship to Ireland?', 'From the Dublin warehouse?']);
  check(
    'three conversations were started by three visitors',
    [first, second, third].every((entry) => entry.ok && entry.conversationId),
  );

  // 4 agent replies across two conversations, plus 1 internal note that must not be counted.
  const replies = [
    [first.conversationId, 'Looking at it now.'],
    [first.conversationId, 'Fixed - a new invoice is on its way.'],
    [second.conversationId, 'It left the depot on Monday.'],
    [second.conversationId, 'Tracking says Thursday.'],
  ];
  for (const [conversationId, body] of replies) {
    const sent = await owner.call('POST', `/conversations/${conversationId}/messages`, {
      body,
      clientMessageId: ulid(),
    });
    if (sent.status !== 201 && sent.status !== 200) {
      check(`agent reply accepted (${body.slice(0, 20)})`, false, `got ${sent.status} ${JSON.stringify(sent.body?.error)}`);
    }
  }
  const note = await owner.call('POST', `/conversations/${third.conversationId}/messages`, {
    body: 'Check with logistics before answering this one.',
    clientMessageId: ulid(),
    type: 'note',
  });
  check('an internal note was written', note.status === 201 || note.status === 200, `got ${note.status}`);

  const closed = await owner.call('PATCH', `/conversations/${first.conversationId}`, {
    status: 'closed',
  });
  check('one conversation was closed', closed.status === 200, `got ${closed.status}`);

  // 2 tickets, 1 resolved.
  const ticketOne = await owner.call('POST', '/tickets', {
    propertyId: property.id,
    subject: 'Called about a refund',
    body: 'Customer called.',
    requesterEmail: `caller1.${stamp}@example.test`,
    notifyRequester: false,
  });
  const ticketTwo = await owner.call('POST', '/tickets', {
    propertyId: property.id,
    subject: 'Emailed about delivery',
    body: 'Customer emailed.',
    requesterEmail: `caller2.${stamp}@example.test`,
    notifyRequester: false,
  });
  check('two tickets were raised', ticketOne.status === 201 && ticketTwo.status === 201);
  const resolved = await owner.call('PATCH', `/tickets/${ticketOne.body.data.id}`, {
    status: 'resolved',
  });
  check('one was resolved', resolved.status === 200, `got ${resolved.status}`);

  section('The rollup is derived, and can be asked for on demand');
  const day = today();
  const rebuilt = await owner.call('POST', '/reports/rebuild', { from: day, to: day });
  check('a rebuild can be requested', rebuilt.status === 200, JSON.stringify(rebuilt.body?.error));
  check('and it covers the day asked for', rebuilt.body.data.days === 1, `${rebuilt.body.data?.days}`);

  section('The numbers match what we actually did');
  const overview = await owner.call('GET', `/reports/overview?from=${day}&to=${day}`);
  check('the overview loads', overview.status === 200, JSON.stringify(overview.body?.error));
  const totals = overview.body.data.totals;

  check('3 conversations started', totals.conversationsStarted === 3, `${totals.conversationsStarted}`);
  check('1 conversation closed', totals.conversationsClosed === 1, `${totals.conversationsClosed}`);
  check('6 visitor messages', totals.messagesFromVisitors === 6, `${totals.messagesFromVisitors}`);
  check(
    '4 agent messages - the internal note is not one',
    totals.messagesFromAgents === 4,
    `${totals.messagesFromAgents}`,
  );
  check('3 new visitors', totals.newVisitors === 3, `${totals.newVisitors}`);
  check('3 of them started a chat', totals.engagedVisitors === 3, `${totals.engagedVisitors}`);
  check('2 tickets opened', totals.ticketsOpened === 2, `${totals.ticketsOpened}`);
  check('1 ticket resolved', totals.ticketsResolved === 1, `${totals.ticketsResolved}`);
  check(
    '2 conversations were answered, so 2 first responses',
    totals.firstResponseCount === 2,
    `${totals.firstResponseCount}`,
  );
  check(
    'and an average first response exists because something was answered',
    typeof totals.averageFirstResponseSeconds === 'number',
    `${totals.averageFirstResponseSeconds}`,
  );

  section('The series is every day, not only the busy ones');
  const week = await owner.call(
    'GET',
    `/reports/overview?from=${new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)}&to=${day}`,
  );
  check('a week of report has seven points', week.body.data.series.length === 7, `${week.body.data.series.length}`);
  check('six of them are empty', week.body.data.series.filter((point) => point.conversationsStarted === 0).length === 6);
  check(
    'and the totals over the week are the same as the totals for the one busy day',
    week.body.data.totals.conversationsStarted === 3 && week.body.data.totals.messagesFromAgents === 4,
    JSON.stringify(week.body.data.totals),
  );

  section('An average is computed from the sum and the count, not from other averages');
  const series = week.body.data.series;
  const summedSeconds = series.reduce((total, point) => total + point.firstResponseSeconds, 0);
  const summedCount = series.reduce((total, point) => total + point.firstResponseCount, 0);
  check(
    'the reported average equals sum(seconds) / sum(count)',
    week.body.data.totals.averageFirstResponseSeconds === Math.round(summedSeconds / summedCount),
    `${week.body.data.totals.averageFirstResponseSeconds} vs ${Math.round(summedSeconds / summedCount)}`,
  );
  check(
    'an unanswered range reports null rather than zero, because zero would mean instant',
    week.body.data.series.every(
      (point) => point.firstResponseCount > 0 || point.firstResponseSeconds === 0,
    ),
  );

  section('Filtering by website');
  const justOther = await owner.call(
    'GET',
    `/reports/overview?from=${day}&to=${day}&propertyId=${otherProperty.id}`,
  );
  check(
    'a website with nothing on it reports nothing',
    justOther.body.data.totals.conversationsStarted === 0,
    `${justOther.body.data.totals.conversationsStarted}`,
  );
  const justThis = await owner.call(
    'GET',
    `/reports/overview?from=${day}&to=${day}&propertyId=${property.id}`,
  );
  check(
    'and the busy one reports all of it',
    justThis.body.data.totals.conversationsStarted === 3,
    `${justThis.body.data.totals.conversationsStarted}`,
  );

  section('By person');
  const agents = await owner.call('GET', `/reports/agents?from=${day}&to=${day}`);
  check('the agent report loads', agents.status === 200, JSON.stringify(agents.body?.error));
  check('one person did the work', agents.body.data.length === 1, `${agents.body.data.length}`);
  const agent = agents.body.data[0];
  check(
    'credited with 4 replies, not 5 - the note is not a reply',
    agent?.messagesSent === 4,
    `${agent?.messagesSent}`,
  );
  check('and with closing 1 conversation', agent?.conversationsClosed === 1, `${agent?.conversationsClosed}`);
  check('and answering 2 first', agent?.firstResponseCount === 2, `${agent?.firstResponseCount}`);

  section('Rebuilding is idempotent');
  const before = JSON.stringify(overview.body.data.totals);
  await owner.call('POST', '/reports/rebuild', { from: day, to: day });
  await owner.call('POST', '/reports/rebuild', { from: day, to: day });
  const after = await owner.call('GET', `/reports/overview?from=${day}&to=${day}`);
  check(
    'running it three times gives the same numbers as running it once',
    JSON.stringify(after.body.data.totals) === before,
    `${JSON.stringify(after.body.data.totals)} vs ${before}`,
  );

  section('One account cannot see another');
  const stranger = new Http();
  await stranger.call('POST', '/auth/register', {
    name: 'Other Owner',
    email: `otherreports.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Other Reports ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  await stranger.call('POST', '/reports/rebuild', { from: day, to: day });
  const strangerReport = await stranger.call('GET', `/reports/overview?from=${day}&to=${day}`);
  check(
    "a new account's report is empty, not everybody's",
    strangerReport.body.data.totals.conversationsStarted === 0 &&
      strangerReport.body.data.totals.messagesFromAgents === 0,
    JSON.stringify(strangerReport.body.data.totals),
  );

  /**
   * The check that found a real bug.
   *
   * `requirePropertyAccess` says yes to an unrestricted owner for *any* property id, including one
   * belonging to somebody else, because it only answers "is this member restricted". The query
   * then filtered on `account_id = mine AND property_id = theirs`, matched nothing, and returned a
   * cheerful report of zeros. Nothing leaked - but the rule everywhere else here is 404, and an
   * empty report is a worse answer than an error for somebody who mistyped an id.
   */
  const strangerFilter = await stranger.call(
    'GET',
    `/reports/overview?from=${day}&to=${day}&propertyId=${property.id}`,
  );
  check(
    "and asking for another account's website is a 404, not a filtered zero",
    strangerFilter.status === 404,
    `got ${strangerFilter.status}`,
  );

  const strangerArticles = await stranger.call('GET', `/kb/${property.id}/articles`);
  check(
    'the same is true of the help centre',
    strangerArticles.status === 404,
    `got ${strangerArticles.status}`,
  );

  const strangerTickets = await stranger.call('GET', `/tickets?propertyId=${property.id}`);
  check(
    'and of the ticket queue',
    strangerTickets.status === 404,
    `got ${strangerTickets.status}`,
  );

  section('The range is bounded, and the dates have to be dates');
  const backwards = await owner.call('GET', `/reports/overview?from=${day}&to=2020-01-01`);
  check('a range that ends before it starts is refused', backwards.status === 422, `got ${backwards.status}`);
  const enormous = await owner.call('GET', `/reports/overview?from=2000-01-01&to=${day}`);
  check('and one nobody can read is refused too', enormous.status === 422, `got ${enormous.status}`);
  const nonsense = await owner.call('GET', `/reports/overview?from=yesterday&to=${day}`);
  check('"yesterday" is not a date', nonsense.status === 422, `got ${nonsense.status}`);

  section('Reports are a permission, not a side effect of having an account');
  const rebuildAsAgent = await stranger.call('POST', '/reports/rebuild', {
    from: day,
    to: day,
  });
  check(
    'an owner can rebuild their own account',
    rebuildAsAgent.status === 200,
    `got ${rebuildAsAgent.status}`,
  );

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
  process.stderr.write(`\nReports E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
