#!/usr/bin/env node
/**
 * Phase 6: automation, shortcuts, and the two forms.
 *
 * The claims under test are the ones a customer makes to their own visitors:
 *
 *   - a trigger really does fire, on a real visit, over a real socket - not on a schedule and not
 *     because an HTTP endpoint asked it to;
 *   - "once per visit" means once;
 *   - a rule scoped to one website never touches another;
 *   - a rule whose conditions do not match stays silent, including when the fact it reads is
 *     simply unknown;
 *   - and a message left when nobody is around lands in the same inbox as everything else.
 *
 *   node scripts/e2e-automation.mjs
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

const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

/**
 * A visitor, held open.
 *
 * Triggers only run for somebody who is actually connected, so the test has to be somebody who is
 * actually connected. Messages that arrive unprompted are collected as they come; `waitForBot`
 * then either finds one or reports honestly that none arrived.
 */
class Visitor {
  constructor(publicId, page = `${ORIGIN}/`) {
    this.publicId = publicId;
    this.page = page;
    this.received = [];
    this.socket = null;
    this.token = null;
    this.sessionId = null;
  }

  async connect() {
    const session = await widgetCall('POST', '/widget/session', {
      p: this.publicId,
      token: this.token ?? undefined,
      page: { url: this.page, title: 'Automation E2E' },
      language: 'en-GB',
      timezone: 'UTC',
    });
    if (session.status !== 200) throw new Error(`bootstrap failed: ${session.status}`);
    this.token = session.body.data.token;
    this.sessionId = session.body.data.sessionId;
    this.agentsAvailable = session.body.data.agentsAvailable;

    const ticket = await widgetCall('POST', '/widget/realtime-ticket', {}, this.token);
    this.socket = await new Promise((resolve, reject) => {
      const client = io(`${REALTIME}/visitor`, {
        transports: ['websocket'],
        auth: { ticket: ticket.body.data.ticket },
        reconnection: false,
        timeout: 10000,
      });
      client.on('message:new', (payload) => {
        if (payload?.message) this.received.push(payload.message);
      });
      client.once('connect', () => resolve(client));
      client.once('connect_error', (error) => reject(error));
    });
    return this;
  }

  /** Wait for a message from the automation, or give up and say so. */
  async waitForBot(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find((message) => message.senderType === 'bot');
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  reportPage(url, title = 'Automation E2E') {
    this.page = url;
    this.socket?.emit('page:view', { url, title });
  }

  start(body, preChat) {
    return new Promise((resolve, reject) => {
      this.socket
        .timeout(10000)
        .emit(
          'conversation:start',
          { clientMessageId: ulid(), body, ...(preChat ? { preChat } : {}) },
          (transportError, ack) => {
            if (transportError) return reject(transportError);
            if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'no ack'));
            return resolve(ack.data);
          },
        );
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

/** Every trigger body needs the same scaffolding; only the interesting parts are passed in. */
function trigger(overrides) {
  return {
    name: 'Rule',
    event: 'visitor_arrived',
    enabled: true,
    match: 'all',
    conditions: [],
    actions: [{ type: 'send_message', body: 'Hello from the robot.' }],
    frequency: 'once_per_session',
    afterSeconds: 0,
    ...overrides,
  };
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Automation Owner',
    email: `auto.${stamp}@example.test`,
    password: 'Thursday-Kestrel-Anvil-73',
    accountName: `Automation ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('owner registered', register.status === 201, `got ${register.status}`);

  const siteA = await owner.call('POST', '/properties', {
    name: 'Shop',
    websiteUrl: `https://shop-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const siteB = await owner.call('POST', '/properties', {
    name: 'Blog',
    websiteUrl: `https://blog-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('two websites created', siteA.status === 201 && siteB.status === 201);
  const shop = siteA.body.data;
  const blog = siteB.body.data;

  section('The builder is served the same vocabulary the engine speaks');
  const schema = await owner.call('GET', '/automation/schema');
  check('the field list is served to the dashboard', schema.status === 200, `got ${schema.status}`);
  const urlField = schema.body.data.fields.find((entry) => entry.field === 'page.url');
  const secondsField = schema.body.data.fields.find(
    (entry) => entry.field === 'session.secondsOnSite',
  );
  check('a text field offers text operators', urlField?.operators.includes('contains') === true);
  check(
    'and never offers one it cannot honour',
    urlField?.operators.includes('gt') === false && secondsField?.operators.includes('contains') === false,
    JSON.stringify(secondsField?.operators),
  );

  section('A rule that could not work is refused, not stored');
  const noWait = await owner.call('POST', '/automation/triggers', trigger({ event: 'time_on_site' }));
  check('a time rule with no wait is refused', noWait.status === 422, `got ${noWait.status}`);

  const strayWait = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({ event: 'page_viewed', afterSeconds: 20 }),
  );
  check('and a wait on an event that does not wait', strayWait.status === 422, `got ${strayWait.status}`);

  const orphanTag = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({ actions: [{ type: 'add_tag', tag: 'hot' }] }),
  );
  check(
    'tagging a conversation the rule never starts is refused',
    orphanTag.status === 422,
    `got ${orphanTag.status}`,
  );

  const badOperator = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({
      conditions: [{ field: 'session.secondsOnSite', operator: 'contains', value: '30' }],
    }),
  );
  check(
    'an operator the field cannot support is refused',
    badOperator.status === 422,
    `got ${badOperator.status}`,
  );

  const foreignDepartment = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({
      event: 'conversation_started',
      actions: [
        { type: 'send_message', body: 'Hi' },
        { type: 'route_to_department', departmentId: '00000000-0000-4000-8000-000000000000' },
      ],
    }),
  );
  check(
    'a department that does not exist is refused',
    foreignDepartment.status === 422,
    `got ${foreignDepartment.status}`,
  );

  const noneStored = await owner.call('GET', '/automation/triggers');
  check('none of them were stored', noneStored.body.data.length === 0, `${noneStored.body.data.length} stored`);

  section('A trigger fires on a real visit');
  const greeting = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({
      name: 'Greet shoppers on the pricing page',
      propertyId: shop.id,
      event: 'time_on_site',
      afterSeconds: 1,
      conditions: [{ field: 'page.url', operator: 'contains', value: '/pricing' }],
      actions: [
        { type: 'send_message', body: 'Can I help you pick a plan?' },
        { type: 'add_tag', tag: 'pricing' },
        { type: 'set_priority', priority: 'high' },
      ],
    }),
  );
  check('the trigger was created', greeting.status === 201, JSON.stringify(greeting.body?.error));

  const shopper = await new Visitor(shop.publicId, `${ORIGIN}/pricing`).connect();
  const botMessage = await shopper.waitForBot();
  check('the visitor received it, unprompted', Boolean(botMessage), 'no bot message arrived');
  check(
    'and it says what the rule said',
    botMessage?.body === 'Can I help you pick a plan?',
    botMessage?.body,
  );
  check(
    'attributed as a bot, not as an agent',
    botMessage?.senderType === 'bot',
    botMessage?.senderType,
  );

  const inbox = await owner.call('GET', '/conversations?status=open&limit=50');
  const created = inbox.body.data.find((entry) => entry.id === botMessage?.conversationId);
  check('it opened a conversation in the inbox', Boolean(created), 'not in the list');
  check('the tag action was applied', created?.tags.includes('pricing') === true, JSON.stringify(created?.tags));
  check('and so was the priority', created?.priority === 'high', created?.priority);

  const counted = await owner.call(`GET`, `/automation/triggers/${greeting.body.data.id}`);
  check('the fire count is real', counted.body.data.fireCount === 1, `${counted.body.data.fireCount}`);
  check('and it records when', Boolean(counted.body.data.lastFiredAt));

  section('Once per visit means once');
  shopper.received.length = 0;
  shopper.reportPage(`${ORIGIN}/pricing?again=1`);
  const again = await shopper.waitForBot(2500);
  check('the same visit is not greeted twice', again === null, again?.body);

  /**
   * Reconnecting is not a new visit.
   *
   * A bootstrap with the same token resumes the session while it is still live, so a visitor who
   * reloads the page has not started a second visit and must not be greeted a second time. This
   * is the check that would catch a dedupe key derived from the socket rather than the session.
   */
  shopper.close();
  const reconnected = new Visitor(shop.publicId, `${ORIGIN}/pricing`);
  reconnected.token = shopper.token;
  await reconnected.connect();
  const afterReload = await reconnected.waitForBot(3500);
  check('and reloading the page is still the same visit', afterReload === null, afterReload?.body);
  reconnected.close();

  // The cap is per person, not a global "this rule has now been used".
  const somebodyElse = await new Visitor(shop.publicId, `${ORIGIN}/pricing`).connect();
  const theirGreeting = await somebodyElse.waitForBot();
  check(
    'a different visitor is still greeted',
    theirGreeting?.body === 'Can I help you pick a plan?',
    theirGreeting?.body ?? 'nothing arrived',
  );
  somebodyElse.close();

  const twice = await owner.call('GET', `/automation/triggers/${greeting.body.data.id}`);
  check('and the count reflects both people', twice.body.data.fireCount === 2, `${twice.body.data.fireCount}`);

  section('Conditions actually narrow');
  const elsewhere = await new Visitor(shop.publicId, `${ORIGIN}/about`).connect();
  const quiet = await elsewhere.waitForBot(3000);
  check('a visitor on another page is left alone', quiet === null, quiet?.body);
  elsewhere.close();

  const otherSite = await new Visitor(blog.publicId, `${ORIGIN}/pricing`).connect();
  const notMySite = await otherSite.waitForBot(3000);
  check(
    'and a rule scoped to one website never fires on another',
    notMySite === null,
    notMySite?.body,
  );
  otherSite.close();

  section('An unknown fact never matches');
  /**
   * The referrer is genuinely unknown for a visitor who arrived without one. A rule written as
   * "came from does not contain google" reads as though it should fire for them - and if it did,
   * the automation would be acting on the absence of information rather than on anything true.
   */
  const negative = await owner.call(
    'POST',
    '/automation/triggers',
    trigger({
      name: 'Should stay silent',
      propertyId: blog.id,
      conditions: [{ field: 'page.referrer', operator: 'not_contains', value: 'google' }],
      actions: [{ type: 'send_message', body: 'This should never be sent.' }],
    }),
  );
  check('the rule was accepted', negative.status === 201, JSON.stringify(negative.body?.error));

  const noReferrer = await new Visitor(blog.publicId, `${ORIGIN}/post`).connect();
  const shouldBeSilent = await noReferrer.waitForBot(3000);
  check(
    'a negative condition on an unknown fact does not fire',
    shouldBeSilent === null,
    shouldBeSilent?.body,
  );
  noReferrer.close();
  await owner.call('DELETE', `/automation/triggers/${negative.body.data.id}`);

  section('Pre-chat answers reach the agent');
  const asker = await new Visitor(shop.publicId, `${ORIGIN}/help`).connect();
  const startedWith = await asker.start('My order has not arrived.', {
    name: 'Rehana',
    email: 'rehana@example.test',
    // Never configured on this property. It must be dropped, not stored.
    sneaky_field: 'should not be kept',
  });
  const withPreChat = await owner.call('GET', `/conversations/${startedWith.conversationId}`);
  const answers = Object.fromEntries(
    (withPreChat.body.data.preChat ?? []).map((entry) => [entry.key, entry.value]),
  );
  check('the answers are on the conversation', answers.name === 'Rehana', JSON.stringify(answers));
  check('including the email', answers.email === 'rehana@example.test');
  check(
    'and a field the property never asked for is dropped',
    answers.sneaky_field === undefined,
    JSON.stringify(answers),
  );
  check(
    'the visitor record learned who they are',
    withPreChat.body.data.visitor.name === 'Rehana',
    withPreChat.body.data.visitor.name,
  );
  asker.close();

  section('Leaving a message when nobody is there');
  const afterHours = await new Visitor(shop.publicId, `${ORIGIN}/contact`).connect();
  check(
    'the widget is told nobody is available',
    afterHours.agentsAvailable === false,
    `${afterHours.agentsAvailable}`,
  );

  const incomplete = await widgetCall(
    'POST',
    '/widget/offline-message',
    { values: { name: 'Karim' } },
    afterHours.token,
  );
  check(
    'a form with the required answers missing is refused',
    incomplete.status === 422,
    `got ${incomplete.status}`,
  );

  const badEmail = await widgetCall(
    'POST',
    '/widget/offline-message',
    { values: { name: 'Karim', email: 'not-an-email', message: 'Hello' } },
    afterHours.token,
  );
  check('and so is an address that is not one', badEmail.status === 422, `got ${badEmail.status}`);

  const left = await widgetCall(
    'POST',
    '/widget/offline-message',
    {
      values: {
        name: 'Karim',
        email: 'karim@example.test',
        message: 'Please call me back about invoice 4471.',
      },
    },
    afterHours.token,
  );
  check('a complete message is accepted', left.status === 200, JSON.stringify(left.body?.error));

  const offlineConversation = await owner.call(
    'GET',
    `/conversations/${left.body.data.conversationId}`,
  );
  check(
    'it lands in the inbox as an offline message',
    offlineConversation.body.data.channel === 'offline_form',
    offlineConversation.body.data.channel,
  );
  const offlineMessages = await owner.call(
    'GET',
    `/conversations/${left.body.data.conversationId}/messages`,
  );
  check(
    'carrying what they actually wrote',
    offlineMessages.body.data.some((m) => m.body === 'Please call me back about invoice 4471.'),
    JSON.stringify(offlineMessages.body.data.map((m) => m.body)),
  );
  const offlineAnswers = Object.fromEntries(
    (offlineConversation.body.data.preChat ?? []).map((entry) => [entry.key, entry.value]),
  );
  check(
    'with a way to reply to them',
    offlineAnswers.email === 'karim@example.test',
    JSON.stringify(offlineAnswers),
  );
  afterHours.close();

  section('Shortcuts');
  const shortcut = await owner.call('POST', '/automation/shortcuts', {
    key: 'refund',
    title: 'Refund policy',
    body: 'Hi {{visitor.name}}, refunds take 5-7 working days once approved.',
  });
  check('a shortcut can be created', shortcut.status === 201, JSON.stringify(shortcut.body?.error));

  const duplicate = await owner.call('POST', '/automation/shortcuts', {
    key: 'REFUND',
    title: 'Another one',
    body: 'Different text.',
  });
  check(
    'the same key cannot be taken twice, whatever the casing',
    duplicate.status === 409,
    `got ${duplicate.status}`,
  );

  const badKey = await owner.call('POST', '/automation/shortcuts', {
    key: 'two words',
    title: 'Nope',
    body: 'Text.',
  });
  check('a key with a space is refused', badKey.status === 422, `got ${badKey.status}`);

  const used = await owner.call('POST', `/automation/shortcuts/${shortcut.body.data.id}/used`, {});
  check('a use can be counted', used.status === 204, `got ${used.status}`);

  const listed = await owner.call('GET', '/automation/shortcuts');
  const stored = listed.body.data.find((entry) => entry.id === shortcut.body.data.id);
  check('the count is real', stored?.usageCount === 1, `${stored?.usageCount}`);
  check(
    'and the placeholder is stored as written, not expanded on the server',
    stored?.body.includes('{{visitor.name}}') === true,
    stored?.body,
  );

  const renamed = await owner.call('PATCH', `/automation/shortcuts/${shortcut.body.data.id}`, {
    title: 'Refunds',
  });
  check('a shortcut can be renamed', renamed.status === 200 && renamed.body.data.title === 'Refunds');

  const removed = await owner.call('DELETE', `/automation/shortcuts/${shortcut.body.data.id}`);
  check('and removed', removed.status === 204, `got ${removed.status}`);
  const afterRemoval = await owner.call('GET', '/automation/shortcuts');
  check('leaving nothing behind', afterRemoval.body.data.length === 0);

  section('Nobody else can reach any of it');
  const stranger = new Http();
  const outsider = await stranger.call('GET', '/automation/triggers');
  check('an unauthenticated caller is refused', outsider.status === 401, `got ${outsider.status}`);

  const strangerRegister = await stranger.call('POST', '/auth/register', {
    name: 'Someone Else',
    email: `stranger.${stamp}@example.test`,
    password: 'Friday-Basalt-Meadow-18',
    accountName: `Stranger ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('another account exists', strangerRegister.status === 201);

  const reachAcross = await stranger.call('GET', `/automation/triggers/${greeting.body.data.id}`);
  check(
    'and cannot read a trigger from the first account - 404, not 403',
    reachAcross.status === 404,
    `got ${reachAcross.status}`,
  );

  const editAcross = await stranger.call('PATCH', `/automation/triggers/${greeting.body.data.id}`, {
    enabled: false,
  });
  check('nor edit it', editAcross.status === 404, `got ${editAcross.status}`);

  const stillOn = await owner.call('GET', `/automation/triggers/${greeting.body.data.id}`);
  check('and the refused edit changed nothing', stillOn.body.data.enabled === true);

  section('Pausing a trigger really stops it');
  const paused = await owner.call('PATCH', `/automation/triggers/${greeting.body.data.id}`, {
    enabled: false,
  });
  check('the trigger can be paused', paused.status === 200 && paused.body.data.enabled === false);

  const afterPause = await new Visitor(shop.publicId, `${ORIGIN}/pricing`).connect();
  const silence = await afterPause.waitForBot(3500);
  check('a paused trigger sends nothing', silence === null, silence?.body);
  afterPause.close();

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
  process.stderr.write(`\nAutomation E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
