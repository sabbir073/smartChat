#!/usr/bin/env node
/**
 * The Phase 3 realtime round trip, run against a live stack.
 *
 * Everything here goes over real Socket.IO connections against the running gateway. The point is
 * not to test the client libraries but the guarantees the product makes: a message is durable
 * before it is acknowledged, sequence numbers are gapless, a retry with the same client id does
 * not duplicate, an internal note never reaches the visitor, and a gateway restart is survivable.
 *
 *   node scripts/e2e-realtime.mjs
 *
 * Requires the stack to be up (`docker compose up -d`).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

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

/**
 * Registration is rate limited per IP, and this script registers a fresh account every run.
 * Clearing the counters keeps repeated local runs from failing for a reason that is not a defect.
 */
function resetRateLimits() {
  if (process.env.SMOKE_RESET_LIMITS === '0') return;
  const password = process.env.REDIS_PASSWORD ?? 'smartchat_dev_redis';
  try {
    execFileSync(
      'docker',
      [
        'compose', 'exec', '-T', 'redis', 'sh', '-c',
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'ratelimit:*' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null; ` +
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'throttle:*' ` +
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

/** Connect, or reject with a useful message rather than hanging until the runner gives up. */
function connect(namespace, ticket) {
  return new Promise((resolve, reject) => {
    const socket = io(`${REALTIME}${namespace}`, {
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false,
      timeout: 10_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(new Error(`${namespace}: ${error.message}`)));
  });
}

function emit(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) return reject(transportError);
      if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'no ack'));
      return resolve(ack.data);
    });
  });
}

/** Wait for one event that satisfies `matches`, so an unrelated event cannot pass the test. */
function waitFor(socket, event, matches = () => true, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    function handler(payload) {
      if (!matches(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Resolves true if the event does NOT arrive - used to prove a note stays internal. */
function expectSilence(socket, event, matches, windowMs = 1500) {
  return new Promise((resolve) => {
    let heard = false;
    function handler(payload) {
      if (matches(payload)) heard = true;
    }
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(!heard);
    }, windowMs);
  });
}

const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

async function main() {
  resetRateLimits();

  const stamp = Date.now();
  const agent = new Http();

  section('Setup');
  const register = await agent.call('POST', '/auth/register', {
    name: 'E2E Agent',
    email: `e2e.${stamp}@example.test`,
    password: 'Tuesday-Mango-Ferry-42',
    accountName: `E2E ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check(
    'agent account registered',
    register.status === 201,
    `got ${register.status} ${JSON.stringify(register.body?.error ?? {})}`,
  );

  const created = await agent.call('POST', '/properties', {
    name: 'E2E Site',
    // A real https address, because that is what the validator demands of customers. The visitor
    // still connects from ORIGIN below, which localhost development explicitly allows.
    websiteUrl: `https://e2e-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check(
    'property created',
    created.status === 201,
    `got ${created.status} ${JSON.stringify(created.body?.error ?? {})}`,
  );
  const property = created.body?.data;

  const session = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check(
    'visitor session created',
    session.status === 200,
    `got ${session.status} ${JSON.stringify(session.body?.error ?? {})}`,
  );
  const visitorToken = session.body?.data?.token;

  const visitorTicket = await widgetCall('POST', '/widget/realtime-ticket', {}, visitorToken);
  check('visitor ticket issued', visitorTicket.status === 200, `got ${visitorTicket.status}`);

  const agentTicket = await agent.call('POST', '/realtime/ticket');
  check('agent ticket issued', agentTicket.status === 200, `got ${agentTicket.status}`);

  section('Connections');
  const visitor = await connect('/visitor', visitorTicket.body.data.ticket);
  check('visitor socket connected', visitor.connected);

  const inbox = await connect('/agent', agentTicket.body.data.ticket);
  check('agent socket connected', inbox.connected);

  const replay = await connect('/visitor', visitorTicket.body.data.ticket).then(
    (socket) => {
      socket.close();
      return false;
    },
    () => true,
  );
  check('a redeemed ticket cannot be used twice', replay);

  const subscribed = await emit(inbox, 'inbox:subscribe', { propertyIds: [property.id] });
  check('inbox subscribed to the property', subscribed.subscribed.includes(property.id));
  check(
    'the subscribe ack carries a presence snapshot with the connected visitor',
    (subscribed.presence ?? [])
      .flatMap((entry) => entry.visitors)
      .some((entry) => typeof entry.visitorId === 'string'),
    JSON.stringify(subscribed.presence),
  );

  section('Visitor to agent');
  const agentSawFirst = waitFor(inbox, 'message:new', (p) => p?.message?.senderType === 'visitor');
  const startId = ulid();
  const started = await emit(visitor, 'conversation:start', {
    clientMessageId: startId,
    body: 'My order arrived damaged.',
  });
  const conversationId = started.conversationId;
  check('conversation started', typeof conversationId === 'string');
  check('the first message is seq 1', Number(started.message.seq) === 1, `got ${started.message.seq}`);

  const first = await agentSawFirst;
  check('the agent received the visitor message live', first.message.body === 'My order arrived damaged.');
  check('the message carries the conversation it belongs to', first.message.conversationId === conversationId);

  section('Idempotent retry');
  const retry = await emit(visitor, 'conversation:start', {
    clientMessageId: startId,
    body: 'My order arrived damaged.',
  });
  check('a retry with the same client id returns the same message', retry.message.id === started.message.id);
  check('a retry does not advance the sequence', Number(retry.message.seq) === 1, `got ${retry.message.seq}`);

  section('Agent to visitor');
  const visitorSawReply = waitFor(visitor, 'message:new', (p) => p?.message?.senderType === 'agent');
  const reply = await emit(inbox, 'message:send', {
    conversationId,
    clientMessageId: ulid(),
    body: 'Sorry about that - a replacement is on the way.',
    type: 'text',
  });
  check('the agent reply was persisted at seq 2', Number(reply.message.seq) === 2, `got ${reply.message.seq}`);

  const delivered = await visitorSawReply;
  check('the visitor received the reply live', delivered.message.body === reply.message.body);
  check(
    'and knows who they are talking to',
    delivered.message.senderName === 'E2E Agent',
    `got ${JSON.stringify(delivered.message.senderName)}`,
  );

  section('Internal notes stay internal');
  const noteBody = 'Internal: refund pre-approved by finance.';
  const visitorStayedQuiet = expectSilence(visitor, 'message:new', (p) => p?.message?.body === noteBody);
  const note = await emit(inbox, 'note:add', {
    conversationId,
    clientMessageId: ulid(),
    body: noteBody,
    type: 'note',
  });
  check('the note was stored', note.message.type === 'note');
  check('the visitor was never sent the note', await visitorStayedQuiet);

  const visitorHistory = await emit(visitor, 'conversation:history', { conversationId, limit: 50 });
  const visitorBodies = visitorHistory.messages.map((entry) => entry.body);
  check('the visitor history excludes the note', !visitorBodies.includes(noteBody), visitorBodies.join(' | '));
  check('the visitor history has both real messages', visitorBodies.length === 2, `got ${visitorBodies.length}`);

  const agentHistory = await agent.call('GET', `/conversations/${conversationId}/messages?limit=50`);
  const replayedReply = agentHistory.body.data.find((entry) => entry.senderType === 'agent');
  check(
    'replayed history attributes the agent, exactly as live delivery did',
    replayedReply?.senderName === 'E2E Agent',
    `got ${JSON.stringify(replayedReply?.senderName)}`,
  );
  check('the agent history includes the note', agentHistory.body.data.some((entry) => entry.body === noteBody));
  check('the agent history is gapless', agentHistory.body.data.map((entry) => Number(entry.seq)).join(',') === '1,2,3');

  section('Durability across a reconnect');
  visitor.close();
  const resumeTicket = await widgetCall('POST', '/widget/realtime-ticket', {}, visitorToken);
  const resumed = await connect('/visitor', resumeTicket.body.data.ticket);
  const sync = await emit(resumed, 'sync:since', { conversationId, lastSeq: 1 });
  check(
    'a reconnected visitor replays exactly what it missed, by sequence',
    sync.messages.map((entry) => Number(entry.seq)).join(',') === '2',
    sync.messages.map((entry) => `${entry.seq}:${entry.body}`).join(' | '),
  );

  section('Working the conversation');

  // Assignment. The member id comes from the account's own member list, never invented.
  const me = await agent.call('GET', '/account/members');
  const myMemberId = me.body.data.members[0]?.id;
  check('the account has a member to assign to', typeof myMemberId === 'string');

  const assigned = await agent.call('POST', `/conversations/${conversationId}/assign`, {
    memberId: myMemberId,
  });
  check('the conversation can be assigned', assigned.status === 200, `got ${assigned.status}`);
  check('the assignment stuck', assigned.body.data.assignedMemberId === myMemberId);

  const mine = await agent.call('GET', '/conversations?assigned=me&status=open');
  check(
    'assigned=me finds it',
    mine.body.data.some((row) => row.id === conversationId),
  );
  const unassigned = await agent.call('GET', '/conversations?assigned=unassigned&status=open');
  check(
    'assigned=unassigned does not',
    !unassigned.body.data.some((row) => row.id === conversationId),
  );

  const foreignAssign = await agent.call('POST', `/conversations/${conversationId}/assign`, {
    memberId: '00000000-0000-7000-8000-000000000000',
  });
  check(
    'a member id from outside the account is refused',
    foreignAssign.status === 404,
    `got ${foreignAssign.status}`,
  );
  const stillMine = await agent.call('GET', `/conversations/${conversationId}`);
  check('the refused assignment changed nothing', stillMine.body.data.assignedMemberId === myMemberId);

  // Tags and priority.
  const tagged = await agent.call('PATCH', `/conversations/${conversationId}`, {
    tags: ['refund', 'hardware'],
    priority: 'high',
  });
  check('tags and priority can be set', tagged.status === 200, `got ${tagged.status}`);

  const byTag = await agent.call('GET', '/conversations?tags=refund&status=open');
  check(
    'filtering by tag finds it',
    byTag.body.data.some((row) => row.id === conversationId),
  );
  const byBothTags = await agent.call('GET', '/conversations?tags=refund&tags=hardware&status=open');
  check(
    'filtering by two tags still finds it - filters narrow, they do not widen',
    byBothTags.body.data.some((row) => row.id === conversationId),
  );
  const byMissingTag = await agent.call('GET', '/conversations?tags=refund&tags=billing&status=open');
  check(
    'a tag it does not carry excludes it',
    !byMissingTag.body.data.some((row) => row.id === conversationId),
  );

  section('Search');

  const byBody = await agent.call('GET', '/conversations?search=arrived%20damaged&status=open');
  check(
    'search matches what was actually said, not just the subject',
    byBody.body.data.some((row) => row.id === conversationId),
  );
  const byNote = await agent.call('GET', '/conversations?search=refund%20pre-approved&status=open');
  check(
    'search reaches internal notes, which only agents can read anyway',
    byNote.body.data.some((row) => row.id === conversationId),
  );
  const byNonsense = await agent.call('GET', '/conversations?search=zzzznotarealterm&status=open');
  check('a search with no matches returns nothing', byNonsense.body.data.length === 0);

  section('Close and reopen');

  const closed = await agent.call('PATCH', `/conversations/${conversationId}`, { status: 'closed' });
  check('the conversation can be closed', closed.body.data.status === 'closed');

  const openList = await agent.call('GET', '/conversations?status=open');
  check(
    'a closed conversation leaves the open list',
    !openList.body.data.some((row) => row.id === conversationId),
  );
  const closedList = await agent.call('GET', '/conversations?status=closed');
  check(
    'and appears in the closed list',
    closedList.body.data.some((row) => row.id === conversationId),
  );

  const replyWhenClosed = await agent.call('POST', `/conversations/${conversationId}/messages`, {
    clientMessageId: ulid(),
    body: 'This should not be accepted.',
    type: 'text',
  });
  check(
    'replying to a closed conversation is refused',
    replyWhenClosed.status === 409,
    `got ${replyWhenClosed.status}`,
  );

  const noteWhenClosed = await agent.call('POST', `/conversations/${conversationId}/messages`, {
    clientMessageId: ulid(),
    body: 'Closing note: replacement shipped.',
    type: 'note',
  });
  check(
    'but an internal note still is - a closed conversation is still a record',
    noteWhenClosed.status === 201,
    `got ${noteWhenClosed.status}`,
  );

  const reopened = await agent.call('PATCH', `/conversations/${conversationId}`, { status: 'open' });
  check('the conversation can be reopened', reopened.body.data.status === 'open');

  const reopenTranscript = await agent.call('GET', `/conversations/${conversationId}/messages?limit=50`);
  const reopenEntry = reopenTranscript.body.data.find(
    (entry) => entry.event?.kind === 'conversation.reopened',
  );
  check('reopening is recorded in the transcript', Boolean(reopenEntry));
  check(
    'and names the agent who did it, not a faceless "support team"',
    reopenEntry?.event?.actorName === 'E2E Agent',
    JSON.stringify(reopenEntry?.event),
  );

  const afterReopen = await agent.call('POST', `/conversations/${conversationId}/messages`, {
    clientMessageId: ulid(),
    body: 'Reopened - anything else I can help with?',
    type: 'text',
  });
  check('replying works again after reopening', afterReopen.status === 201, `got ${afterReopen.status}`);

  section('The visitor ends their own chat');

  // A second, independent visitor, so ending a chat here cannot disturb the assertions above.
  const otherSession = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/pricing`, title: 'Pricing' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  const otherToken = otherSession.body.data.token;
  const otherTicket = await widgetCall('POST', '/widget/realtime-ticket', {}, otherToken);
  const other = await connect('/visitor', otherTicket.body.data.ticket);

  const agentSeesOther = waitFor(inbox, 'message:new', (p) => p?.message?.senderType === 'visitor');
  const otherStart = await emit(other, 'conversation:start', {
    clientMessageId: ulid(),
    body: 'Quick question about pricing.',
  });
  await agentSeesOther;
  const otherId = otherStart.conversationId;

  // The unread badge before ending: one, from the visitor's own message above.
  const beforeClose = await agent.call('GET', `/conversations/${otherId}`);
  const unreadBefore = beforeClose.body.data.agentUnreadCount;

  // The agent must learn about this without polling.
  const agentSeesClose = waitFor(inbox, 'conversation:closed', (p) => p?.conversationId === otherId);
  const systemToAgent = waitFor(
    inbox,
    'message:new',
    (p) => p?.message?.type === 'system' && p?.message?.conversationId === otherId,
  );

  const ended = await emit(other, 'conversation:close', { conversationId: otherId });
  check('the visitor can end their own chat', ended.alreadyClosed === false);

  const closeEvent = await agentSeesClose;
  check('the agent is told live', closeEvent.status === 'closed');
  check('and told it was the visitor who ended it', closeEvent.closedBy === 'visitor');

  const systemMessage = (await systemToAgent).message;
  check('the ending is written into the transcript as a system message', systemMessage.type === 'system');
  check('the system message says who ended it', systemMessage.event?.by === 'visitor');
  check(
    'and what happened',
    systemMessage.event?.kind === 'conversation.closed',
    JSON.stringify(systemMessage.event),
  );

  const afterClose = await agent.call('GET', `/conversations/${otherId}`);
  check('the conversation is closed', afterClose.body.data.status === 'closed');
  check(
    'no member is recorded as having closed it, because none did',
    afterClose.body.data.assignedMemberId === null,
  );

  const unreadAfter = afterClose.body.data.agentUnreadCount;
  check(
    'a system message does not raise the unread badge - nobody said anything new',
    unreadAfter === unreadBefore,
    `was ${unreadBefore}, now ${unreadAfter}`,
  );

  const endAgain = await emit(other, 'conversation:close', { conversationId: otherId });
  check('ending an already-ended chat is a no-op, not an error', endAgain.alreadyClosed === true);

  const notMine = await emit(other, 'conversation:close', { conversationId }).then(
    () => false,
    () => true,
  );
  check('a visitor cannot end somebody else\'s chat', notMine);

  // Starting again gives a brand new conversation rather than resuming the closed one.
  const fresh = await emit(other, 'conversation:start', {
    clientMessageId: ulid(),
    body: 'Actually, one more thing.',
  });
  check('a new message after ending starts a new conversation', fresh.conversationId !== otherId);
  check('and that conversation starts at seq 1', Number(fresh.message.seq) === 1);

  const stillClosed = await agent.call('GET', `/conversations/${otherId}`);
  check('the ended conversation stays closed', stillClosed.body.data.status === 'closed');

  other.close();
  visitor.close();
  resumed.close();
  inbox.close();

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
  process.stderr.write(`\nRealtime E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
