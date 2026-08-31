#!/usr/bin/env node
/**
 * The tenant isolation suite.
 *
 * Every other suite in this directory asks "does this feature work". This one asks the single
 * question a multi-tenant product has to answer correctly every time, for every resource, on every
 * path: **can one account reach another's data?**
 *
 * The method is deliberately blunt. Two accounts are built, each with a full set of records, and
 * then account B is handed the real, valid identifiers of everything account A owns - ids nobody
 * would normally have, which is exactly the situation after a leak, a screenshot, a shared URL or
 * a bug in somebody else's integration. Every one of them must answer **404**, not 403 and
 * certainly not 200.
 *
 * 404 rather than 403 is not pedantry. "You are not allowed to see conversation X" confirms that
 * conversation X exists, which is enough to enumerate a competitor's customer base one id at a
 * time. The rule this codebase holds is that a resource which is not yours is indistinguishable
 * from one that does not exist.
 *
 *   node scripts/e2e-isolation.mjs
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
  constructor(label) {
    this.label = label;
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

  async call(method, path, body, extraHeaders = {}) {
    const headers = { accept: 'application/json', ...extraHeaders };
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

/**
 * Emit and report the outcome instead of throwing.
 *
 * These checks care about *refusal*, so a rejected event is the expected result and has to be
 * inspectable: `{ ok: false, code }` carries the code the gateway actually sent, which is what
 * lets a test tell "not yours" apart from "the handler crashed".
 */
function emitOutcome(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) return resolve({ ok: false, code: 'TIMEOUT' });
      if (!ack?.success) return resolve({ ok: false, code: ack?.error?.code ?? 'NO_ACK' });
      return resolve({ ok: true, data: ack.data });
    });
  });
}

/** Hand a ticket to the gateway and report what happened, without throwing. */
function connectVisitorGateway(ticket) {
  return new Promise((resolve) => {
    const socket = io(`${REALTIME}/visitor`, {
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false,
      timeout: 10_000,
    });
    socket.once('connect', () => {
      socket.close();
      resolve('connected');
    });
    socket.once('connect_error', (error) => {
      socket.close();
      resolve(error.message);
    });
  });
}

/** Open a visitor socket the way the widget does: mint a ticket, then present it. */
async function visitorSocket(token) {
  const ticket = await widgetCall('POST', '/widget/realtime-ticket', {}, token);
  if (ticket.status !== 200) throw new Error(`realtime ticket refused: ${ticket.status}`);
  return new Promise((resolve, reject) => {
    const socket = io(`${REALTIME}/visitor`, {
      transports: ['websocket'],
      auth: { ticket: ticket.body.data.ticket },
      reconnection: false,
      timeout: 10_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Build a complete account: website, conversation, contact, ticket, article, key, webhook. */
async function buildAccount(label, stamp) {
  const client = new Http(label);
  await client.call('POST', '/auth/register', {
    name: `${label} Owner`,
    email: `${label.toLowerCase()}.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `${label} ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });

  const site = await client.call('POST', '/properties', {
    name: `${label} site`,
    websiteUrl: `https://${label.toLowerCase()}-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const property = site.body.data;

  // A conversation started the way a real one is: over the socket.
  const session = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Isolation' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  const visitorToken = session.body.data.token;
  const rt = await widgetCall('POST', '/widget/realtime-ticket', {}, visitorToken);
  const socket = await new Promise((resolve, reject) => {
    const s = io(`${REALTIME}/visitor`, {
      transports: ['websocket'],
      auth: { ticket: rt.body.data.ticket },
      reconnection: false,
      timeout: 10000,
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
  const started = await emit(socket, 'conversation:start', {
    clientMessageId: ulid(),
    body: `A private message belonging to ${label}.`,
  });
  socket.close();

  await client.call('POST', `/conversations/${started.conversationId}/messages`, {
    body: `A private reply belonging to ${label}.`,
    clientMessageId: ulid(),
  });

  // A contact, via the offline form, which is the one path that creates one.
  const offlineSession = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Isolation' },
  });
  await widgetCall(
    'POST',
    '/widget/offline-message',
    {
      values: {
        name: `${label} Person`,
        email: `person.${label.toLowerCase()}.${stamp}@example.test`,
        message: `Private enquiry belonging to ${label}.`,
      },
    },
    offlineSession.body.data.token,
  );
  const contacts = await client.call('GET', '/contacts');

  const ticket = await client.call('POST', '/tickets', {
    propertyId: property.id,
    subject: `${label} ticket`,
    body: 'Private.',
    requesterEmail: `t.${label.toLowerCase()}.${stamp}@example.test`,
    notifyRequester: false,
  });

  const category = await client.call('POST', `/kb/${property.id}/categories`, {
    name: `${label} section`,
  });
  const article = await client.call('POST', `/kb/${property.id}/articles`, {
    title: `${label} article`,
    body: 'Private draft.',
    status: 'draft',
  });

  const trigger = await client.call('POST', '/automation/triggers', {
    name: `${label} trigger`,
    event: 'visitor_arrived',
    match: 'all',
    conditions: [{ field: 'page.url', operator: 'starts_with', value: 'https://' }],
    actions: [{ type: 'send_message', body: 'Hello from a private trigger.' }],
    frequency: 'once_per_session',
  });
  const shortcut = await client.call('POST', '/automation/shortcuts', {
    key: `${label.toLowerCase()}sc`,
    title: `${label} shortcut`,
    body: 'Private text.',
  });

  const key = await client.call('POST', '/integrations/keys', {
    name: `${label} key`,
    scopes: ['tickets:read', 'contacts:read', 'articles:read', 'conversations:read'],
  });
  const webhook = await client.call('POST', '/integrations/webhooks', {
    name: `${label} webhook`,
    url: `https://example.com/${label.toLowerCase()}`,
    events: ['ticket.created'],
  });

  const members = await client.call('GET', '/account/members');

  return {
    client,
    property,
    visitorToken,
    conversationId: started.conversationId,
    contactId: contacts.body.data?.[0]?.id ?? null,
    ticketId: ticket.body.data.id,
    categoryId: category.body.data.id,
    articleId: article.body.data.id,
    articleSlug: article.body.data.slug,
    triggerId: trigger.body.data.id,
    shortcutId: shortcut.body.data.id,
    apiKey: key.body.data.secretShownOnce,
    apiKeyId: key.body.data.id,
    webhookId: webhook.body.data.id,
    memberId: members.body.data.members[0].id,
  };
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();

  section('Two complete accounts');
  const a = await buildAccount('Alpha', stamp);
  const b = await buildAccount('Beta', stamp);
  check('account A is complete', Boolean(a.conversationId && a.ticketId && a.articleId));
  check('account B is complete', Boolean(b.conversationId && b.ticketId && b.articleId));
  check('and they really are different accounts', a.property.id !== b.property.id);
  check('A has a contact to protect', Boolean(a.contactId), `${a.contactId}`);

  /**
   * Every read, as the wrong account, with a real id.
   *
   * `[label, method, path]`. 404 is the only acceptable answer; 403 is a failure because it
   * confirms the row exists, and anything 2xx is a breach.
   */
  const reads = [
    ['a conversation', 'GET', `/conversations/${a.conversationId}`],
    ['a conversation transcript', 'GET', `/conversations/${a.conversationId}/messages`],
    ['a contact', 'GET', `/contacts/${a.contactId}`],
    ['a contact history', 'GET', `/contacts/${a.contactId}/history`],
    ['a ticket', 'GET', `/tickets/${a.ticketId}`],
    ['a ticket thread', 'GET', `/tickets/${a.ticketId}/messages`],
    ['an article', 'GET', `/kb/articles/${a.articleId}`],
    ["a website's article list", 'GET', `/kb/${a.property.id}/articles`],
    ["a website's sections", 'GET', `/kb/${a.property.id}/categories`],
    ['a website', 'GET', `/properties/${a.property.id}`],
    ['an installation snippet', 'GET', `/properties/${a.property.id}/install`],
    ['a widget configuration', 'GET', `/properties/${a.property.id}/widget`],
    ['a webhook delivery log', 'GET', `/integrations/webhooks/${a.webhookId}/deliveries`],
    ['a report filtered to their website', 'GET', `/reports/overview?from=2026-08-01&to=2026-08-30&propertyId=${a.property.id}`],
    ['a ticket queue filtered to their website', 'GET', `/tickets?propertyId=${a.property.id}`],
  ];

  section('B tries to read A, with real identifiers');
  for (const [label, method, path] of reads) {
    const result = await b.client.call(method, path);
    check(
      `${label}: 404, not 403 and certainly not 200`,
      result.status === 404,
      `got ${result.status}`,
    );
  }

  const writes = [
    ['reply to a conversation', 'POST', `/conversations/${a.conversationId}/messages`, { body: 'Injected.', clientMessageId: ulid() }],
    ['close a conversation', 'PATCH', `/conversations/${a.conversationId}`, { status: 'closed' }],
    ['assign a conversation', 'POST', `/conversations/${a.conversationId}/assign`, { memberId: b.memberId }],
    ['edit a contact', 'PATCH', `/contacts/${a.contactId}`, { name: 'Renamed by a stranger' }],
    ['reply to a ticket', 'POST', `/tickets/${a.ticketId}/messages`, { body: 'Injected.', visibility: 'public' }],
    ['change a ticket', 'PATCH', `/tickets/${a.ticketId}`, { status: 'closed' }],
    ['delete a ticket', 'DELETE', `/tickets/${a.ticketId}`, undefined],
    ['edit an article', 'PATCH', `/kb/articles/${a.articleId}`, { title: 'Rewritten by a stranger' }],
    ['publish an article', 'PATCH', `/kb/articles/${a.articleId}`, { status: 'published' }],
    ['delete an article', 'DELETE', `/kb/articles/${a.articleId}`, undefined],
    ['delete a section', 'DELETE', `/kb/categories/${a.categoryId}`, undefined],
    ['change a website', 'PATCH', `/properties/${a.property.id}`, { name: 'Taken over' }],
    ['delete a website', 'DELETE', `/properties/${a.property.id}`, undefined],
    ['change a trigger', 'PATCH', `/automation/triggers/${a.triggerId}`, { enabled: false }],
    ['delete a shortcut', 'DELETE', `/automation/shortcuts/${a.shortcutId}`, undefined],
    ['revoke an API key', 'DELETE', `/integrations/keys/${a.apiKeyId}`, undefined],
    ['change a webhook', 'PATCH', `/integrations/webhooks/${a.webhookId}`, { enabled: false }],
    ['delete a webhook', 'DELETE', `/integrations/webhooks/${a.webhookId}`, undefined],
    ['ping a webhook', 'POST', `/integrations/webhooks/${a.webhookId}/ping`, undefined],
  ];

  /**
   * Prove that every path above is a path this API actually serves.
   *
   * This suite's whole argument rests on 404 meaning "not yours". A URL with a typo in it also
   * answers 404 - from Fastify's not-found handler, before any of our code runs - and would sail
   * through every check below while testing nothing. That failure mode is not hypothetical: the
   * first version of this file spent five checks on a `/widget/conversations` route that does not
   * exist, and they all passed.
   *
   * The discriminator is authentication. A real route rejects an anonymous caller in its auth
   * hook, so it answers 401; a route that does not exist never gets that far and answers 404. So
   * every path is called once with no credentials at all, which is also completely side-effect
   * free - the handler is never reached, so even the DELETEs cannot touch anything.
   */
  section('Every path these checks use is a real path');
  const unauthenticated = new Http('unauthenticated');
  let phantom = 0;
  for (const [label, method, path] of [...reads, ...writes]) {
    const probe = await unauthenticated.call(method, path);
    if (probe.status === 401) continue;
    phantom += 1;
    check(`${method} ${path} (${label}) is a route this API serves`, false, `got ${probe.status}`);
  }
  check(
    `all ${reads.length + writes.length} paths are served by the API, so a 404 below means "not yours"`,
    phantom === 0,
    `${phantom} path(s) are not routes`,
  );

  section('B tries to write to A');
  for (const [label, method, path, body] of writes) {
    const result = await b.client.call(method, path, body);
    check(`${label}: refused`, result.status === 404, `got ${result.status}`);
  }

  section("...and A's data is genuinely unchanged afterwards");
  const conversation = await a.client.call('GET', `/conversations/${a.conversationId}`);
  check('the conversation is still open', conversation.body.data.status === 'open', conversation.body.data?.status);
  const transcript = await a.client.call('GET', `/conversations/${a.conversationId}/messages`);
  check(
    'and nothing was injected into its transcript',
    !JSON.stringify(transcript.body.data).includes('Injected.'),
  );
  const ticket = await a.client.call('GET', `/tickets/${a.ticketId}`);
  check('the ticket still exists and is still open', ticket.status === 200 && ticket.body.data.status === 'open');
  const article = await a.client.call('GET', `/kb/articles/${a.articleId}`);
  check(
    'the article is still a draft with its own title',
    article.body.data.status === 'draft' && article.body.data.title === `Alpha article`,
    `${article.body.data?.status} ${article.body.data?.title}`,
  );
  const property = await a.client.call('GET', `/properties/${a.property.id}`);
  check('the website still belongs to A, with its own name', property.body.data.name === 'Alpha site');

  section("B's own lists never contain A's rows");
  const lists = [
    ['conversations', '/conversations'],
    ['contacts', '/contacts'],
    ['tickets', '/tickets'],
    ['websites', '/properties'],
    ['triggers', '/automation/triggers'],
    ['shortcuts', '/automation/shortcuts'],
    ['API keys', '/integrations/keys'],
    ['webhooks', '/integrations/webhooks'],
  ];
  for (const [label, path] of lists) {
    const result = await b.client.call('GET', path);
    const serialised = JSON.stringify(result.body.data ?? {});
    check(
      `${label}: no id belonging to A appears`,
      !serialised.includes(a.property.id) &&
        !serialised.includes(a.conversationId) &&
        !serialised.includes(a.ticketId) &&
        !serialised.includes(a.articleId),
    );
  }

  section("An API key is scoped to its own account too");
  const keyReads = [
    ['a conversation', `/conversations/${a.conversationId}`],
    ['a ticket', `/tickets/${a.ticketId}`],
    ['a contact', `/contacts/${a.contactId}`],
    ['an article', `/kb/articles/${a.articleId}`],
  ];
  for (const [label, path] of keyReads) {
    const response = await fetch(`${API}/api/v1${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${b.apiKey}` },
    });
    check(`B's key cannot read A's ${label}`, response.status === 404, `got ${response.status}`);
  }

  section('A visitor is confined to their own conversation, website and account');

  /**
   * A visitor reads and writes over the realtime gateway, not over REST - there is no
   * `/widget/conversations` route at all. An earlier version of this suite asserted 404 against
   * one and passed, for the worst possible reason: Fastify could not find the route. That is the
   * exact shape of a test that guards nothing, so these checks go through the socket the widget
   * actually uses, and assert on the error code the gateway returns rather than on a status that
   * an absent route would produce for free.
   */
  const bVisitor = await visitorSocket(b.visitorToken);

  const visitorReadsOther = await emitOutcome(bVisitor, 'conversation:history', {
    conversationId: a.conversationId,
    limit: 50,
  });
  check(
    "B's visitor cannot read A's conversation",
    visitorReadsOther.ok === false,
    JSON.stringify(visitorReadsOther),
  );
  check(
    'and is told it does not exist rather than that it is forbidden',
    visitorReadsOther.code === 'CONVERSATION_NOT_FOUND',
    `got ${visitorReadsOther.code}`,
  );

  const visitorWritesOther = await emitOutcome(bVisitor, 'message:send', {
    conversationId: a.conversationId,
    clientMessageId: ulid(),
    body: 'Injected by a visitor.',
  });
  check(
    'and cannot write to it',
    visitorWritesOther.ok === false,
    JSON.stringify(visitorWritesOther),
  );

  const visitorSyncsOther = await emitOutcome(bVisitor, 'sync:since', {
    conversationId: a.conversationId,
    lastSeq: 0,
  });
  check(
    'and cannot resync it to read the same messages another way',
    visitorSyncsOther.ok === false,
    JSON.stringify(visitorSyncsOther),
  );

  const visitorClosesOther = await emitOutcome(bVisitor, 'conversation:close', {
    conversationId: a.conversationId,
  });
  check(
    'and cannot close it',
    visitorClosesOther.ok === false,
    JSON.stringify(visitorClosesOther),
  );
  bVisitor.close();

  // A refusal is only worth something if the thread really is untouched afterwards.
  const afterVisitor = await a.client.call('GET', `/conversations/${a.conversationId}/messages`);
  check(
    "and A's transcript is unchanged afterwards",
    afterVisitor.status === 200 &&
      !JSON.stringify(afterVisitor.body).includes('Injected by a visitor.'),
    `got ${afterVisitor.status}`,
  );

  const crossProperty = await widgetCall('POST', '/widget/session', {
    // A real token from one property, a real public id from another.
    p: a.property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Isolation' },
  });
  check('a session for another website issues its own identity', crossProperty.status === 200);
  check(
    'and not the one that was presented',
    crossProperty.body.data.token !== b.visitorToken,
  );

  const noToken = await widgetCall('GET', '/widget/me');
  check(
    'a widget request with no credential is refused',
    noToken.status === 401,
    `got ${noToken.status}`,
  );

  const forgedToken = await widgetCall('GET', '/widget/me', undefined, `${b.visitorToken}tampered`);
  check(
    'and a tampered visitor token is refused rather than truncated back to a valid one',
    forgedToken.status === 401,
    `got ${forgedToken.status}`,
  );

  const forgedTicketRequest = await widgetCall(
    'POST',
    '/widget/realtime-ticket',
    {},
    `${b.visitorToken}tampered`,
  );
  check(
    'and cannot be exchanged for a gateway ticket either',
    forgedTicketRequest.status === 401,
    `got ${forgedTicketRequest.status}`,
  );

  const neverIssued = await connectVisitorGateway('a-ticket-that-was-never-issued');
  check(
    'a gateway ticket nobody issued does not open a socket',
    neverIssued === 'unauthorised',
    `got ${neverIssued}`,
  );

  // Single-use is the whole reason the ticket is safe to put in a handshake, so it is worth
  // proving rather than assuming: the same string twice must not work twice.
  const oneShot = await widgetCall('POST', '/widget/realtime-ticket', {}, b.visitorToken);
  const firstUse = await connectVisitorGateway(oneShot.body.data.ticket);
  const secondUse = await connectVisitorGateway(oneShot.body.data.ticket);
  check('a freshly issued gateway ticket connects once', firstUse === 'connected', `got ${firstUse}`);
  check(
    'and the very same ticket a second time does not',
    secondUse === 'unauthorised',
    `got ${secondUse}`,
  );

  section('The public help centre leaks nothing private');
  const publicIndex = await fetch(`${API}/api/v1/public/kb/${a.property.publicId}`);
  const publicBody = await publicIndex.text();
  check('the public help centre answers', publicIndex.status === 200, `got ${publicIndex.status}`);
  check(
    "and A's draft article is not in it",
    !publicBody.includes('Alpha article') && !publicBody.includes(a.articleId),
  );
  const draftBySlug = await fetch(
    `${API}/api/v1/public/kb/${a.property.publicId}/articles/${a.articleSlug}`,
  );
  check('a draft is a 404 to a stranger', draftBySlug.status === 404, `got ${draftBySlug.status}`);

  section('Headers and cursors are not authorisation');
  const forgedAccountHeader = await b.client.call('GET', '/conversations', undefined, {
    // The account header is a *request* to act on an account, never a claim to be a member of it.
    'x-account-id': a.property.accountId ?? '00000000-0000-0000-0000-000000000000',
  });
  check(
    'an x-account-id header for an account you do not belong to does not grant it',
    forgedAccountHeader.status === 404 || forgedAccountHeader.status === 200,
    `got ${forgedAccountHeader.status}`,
  );
  if (forgedAccountHeader.status === 200) {
    check(
      "and if it is ignored, the result is still B's own data",
      !JSON.stringify(forgedAccountHeader.body.data).includes(a.conversationId),
    );
  }

  const forgedCursor = await b.client.call(
    'GET',
    `/conversations?cursor=${Buffer.from('2030-01-01T00:00:00.000Z|' + a.conversationId).toString('base64url')}`,
  );
  check(
    'a cursor forged from another account\'s row returns nothing of theirs',
    forgedCursor.status === 200 &&
      !JSON.stringify(forgedCursor.body.data).includes(a.conversationId),
    `got ${forgedCursor.status}`,
  );

  const nonsenseId = await b.client.call('GET', '/conversations/not-a-uuid');
  check('an id that is not an id is a validation failure, not a 500', nonsenseId.status === 422, `got ${nonsenseId.status}`);

  section('Signed out is signed out');
  const anonymous = new Http('anonymous');
  for (const [label, path] of [
    ['conversations', '/conversations'],
    ['tickets', '/tickets'],
    ['contacts', '/contacts'],
    ['reports', '/reports/overview?from=2026-08-01&to=2026-08-30'],
    ['API keys', '/integrations/keys'],
    ['the platform console', '/platform/accounts'],
  ]) {
    const result = await anonymous.call('GET', path);
    check(`${label} require a session`, result.status === 401, `got ${result.status}`);
  }

  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(`${passed} checks passed. No path from one account to another.\n\n`);
    process.exit(0);
  }
  process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
  for (const name of failures) process.stdout.write(`  - ${name}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\nIsolation suite crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
