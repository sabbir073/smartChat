#!/usr/bin/env node
/**
 * The abuse-control suite.
 *
 * A ban is the one control in this product whose entire value is that it survives the obvious
 * attempt to shrug it off: reload the page. The schema has carried `is_banned` since phase 1 and
 * `VisitorService.authenticate` has always refused a banned identity - but `bootstrap` did not,
 * which meant a banned visitor could reload, be recognised as a returning visitor, be handed a
 * brand-new token, and carry on. The ban lasted exactly one page view.
 *
 * So this suite is written around that failure rather than around the happy path. It bans a real
 * visitor and then tries every door: the token they already hold, a fresh session from the same
 * browser identity, and a gateway ticket. It also checks the things a moderation feature gets
 * wrong quietly - that the ban is one person and not the whole website, that an agent cannot
 * apply one, that another account cannot apply one to your visitor, and that lifting it actually
 * lifts it.
 *
 *   node scripts/e2e-abuse.mjs
 *
 * Requires the full stack.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const MAILPIT = process.env.SMOKE_MAILPIT_URL ?? 'http://localhost:8025';
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

/** Register an account and give it a website. */
async function newAccount(label, stamp) {
  const client = new Http();
  const email = `${label}.${stamp}@example.test`;
  await client.call('POST', '/auth/register', {
    name: `${label} Owner`,
    email,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `${label} ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  const site = await client.call('POST', '/properties', {
    name: `${label} site`,
    websiteUrl: `https://${label}-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  return { client, email, property: site.body.data };
}

/** A visitor, with a live conversation, exactly the way the widget makes one. */
async function newVisitor(publicId, body) {
  const session = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/`, title: 'Abuse E2E' },
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
  const started = await new Promise((resolve, reject) => {
    socket
      .timeout(10000)
      .emit('conversation:start', { clientMessageId: ulid(), body }, (transportError, ack) => {
        if (transportError) return reject(transportError);
        if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'no ack'));
        return resolve(ack.data);
      });
  });
  socket.close();
  return { token, conversationId: started.conversationId };
}

async function invitationLinkFor(email, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      if (response.ok) {
        const found = await response.json();
        const latest = found.messages?.[0];
        if (latest) {
          const detail = await fetch(`${MAILPIT}/api/v1/message/${latest.ID}`).then((r) => r.json());
          const text = `${detail.Text ?? ''} ${detail.HTML ?? ''}`;
          const match = /accept-invitation\?token=([A-Za-z0-9._~%-]+)/.exec(text);
          if (match) return decodeURIComponent(match[1]);
        }
      }
    } catch {
      /* Mailpit may not be up on the first attempt. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();

  section('An account, a website, and a visitor with something to say');
  const owner = await newAccount('abuse', stamp);
  const visitor = await newVisitor(owner.property.publicId, 'I am going to be difficult.');
  check('the visitor started a conversation', Boolean(visitor.conversationId));

  const conversation = await owner.client.call(
    'GET',
    `/conversations/${visitor.conversationId}`,
  );
  const visitorId = conversation.body.data?.visitor?.id;
  check('the agent can see who they are talking to', Boolean(visitorId), `${visitorId}`);
  check(
    'and they are not banned to begin with',
    conversation.body.data?.visitor?.isBanned === false,
  );

  section('Banning them closes every door, not just the one they came through');
  const banned = await owner.client.call('POST', `/visitors/${visitorId}/ban`, {
    reason: 'Abusive language',
  });
  check('the ban is accepted', banned.status === 200, `got ${banned.status}`);
  check('and it is permanent when no end is given', banned.body.data?.bannedUntil === null);

  const meAfter = await widgetCall('GET', '/widget/me', undefined, visitor.token);
  check(
    'the token they are holding stops working',
    meAfter.status === 403 && meAfter.body?.error?.code === 'VISITOR_BANNED',
    `got ${meAfter.status} ${meAfter.body?.error?.code}`,
  );

  const ticketAfter = await widgetCall('POST', '/widget/realtime-ticket', {}, visitor.token);
  check(
    'and cannot be exchanged for a gateway ticket',
    ticketAfter.status === 403,
    `got ${ticketAfter.status}`,
  );

  /**
   * The one that matters. Reloading the page is what any banned person does next, and bootstrap
   * recognises them from the token their browser kept - so if it does not check the ban, it hands
   * them a fresh identity and the ban is over.
   */
  const reload = await widgetCall('POST', '/widget/session', {
    p: owner.property.publicId,
    token: visitor.token,
    page: { url: `${ORIGIN}/`, title: 'Abuse E2E' },
  });
  check(
    'and reloading the page does not mint them a new one',
    reload.status === 403 && reload.body?.error?.code === 'VISITOR_BANNED',
    `got ${reload.status} ${reload.body?.error?.code}`,
  );

  section('A ban is one person, not the website');
  const bystander = await newVisitor(owner.property.publicId, 'I only came to ask about delivery.');
  check('somebody else can still start a chat', Boolean(bystander.conversationId));
  const bystanderMe = await widgetCall('GET', '/widget/me', undefined, bystander.token);
  check('and their token works', bystanderMe.status === 200, `got ${bystanderMe.status}`);

  section('The ban shows up where somebody can act on it');
  const reread = await owner.client.call('GET', `/conversations/${visitor.conversationId}`);
  check(
    'the conversation reports the visitor as banned',
    reread.body.data?.visitor?.isBanned === true,
  );

  const audit = await owner.client.call('GET', '/account/audit-logs?action=visitor.banned&limit=5');
  const entry = (audit.body.data ?? [])[0];
  check('and the audit log records it', audit.status === 200 && Boolean(entry), `got ${audit.status}`);
  check(
    'against the right visitor, with the reason the manager typed',
    entry?.resourceId === visitorId && JSON.stringify(entry?.metadata).includes('Abusive language'),
    JSON.stringify(entry?.metadata),
  );

  section('Lifting it actually lifts it');
  const lifted = await owner.client.call('DELETE', `/visitors/${visitorId}/ban`);
  check('the ban can be lifted', lifted.status === 200, `got ${lifted.status}`);

  const meAgain = await widgetCall('GET', '/widget/me', undefined, visitor.token);
  check(
    'and the original token works again',
    meAgain.status === 200,
    `got ${meAgain.status} ${meAgain.body?.error?.code}`,
  );

  /**
   * The control for the reload check above.
   *
   * That check asserts 403 from `/widget/session`. On its own that proves very little - a 403 from
   * an endpoint that always 403s would pass it just as happily. So the *same call*, with the same
   * token, on the same property, is made again now that the ban is lifted: it must succeed and
   * return a working identity. Together the two say the refusal came from the ban and nothing else.
   */
  const reloadAllowed = await widgetCall('POST', '/widget/session', {
    p: owner.property.publicId,
    token: visitor.token,
    page: { url: `${ORIGIN}/`, title: 'Abuse E2E' },
  });
  check(
    'and the identical reload that was refused now succeeds',
    reloadAllowed.status === 200 && Boolean(reloadAllowed.body.data?.token),
    `got ${reloadAllowed.status}`,
  );
  check(
    'recognising them as the same returning visitor rather than a new one',
    reloadAllowed.body.data?.visitor?.id === visitorId,
    `${reloadAllowed.body.data?.visitor?.id}`,
  );

  section('A temporary ban is a date, and the date has to be in the future');
  const past = await owner.client.call('POST', `/visitors/${visitorId}/ban`, {
    until: new Date(Date.now() - 60_000).toISOString(),
  });
  check(
    'a ban that ended before it began is refused',
    past.status === 422,
    `got ${past.status}`,
  );

  const hour = await owner.client.call('POST', `/visitors/${visitorId}/ban`, {
    until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check('an hour-long ban is accepted', hour.status === 200, `got ${hour.status}`);
  check('and it carries its end date', Boolean(hour.body.data?.bannedUntil));

  const duringTemporary = await widgetCall('GET', '/widget/me', undefined, visitor.token);
  check(
    'the visitor is refused while it lasts',
    duringTemporary.status === 403,
    `got ${duringTemporary.status}`,
  );
  await owner.client.call('DELETE', `/visitors/${visitorId}/ban`);

  section('Who is allowed to do this');
  const agentEmail = `abuse.agent.${stamp}@example.test`;
  const invited = await owner.client.call('POST', '/team/members', {
    email: agentEmail,
    baseRole: 'agent',
    restrictedToProperties: false,
  });
  check('an agent can be invited', invited.status === 201, `got ${invited.status}`);

  const token = await invitationLinkFor(agentEmail);
  check('the invitation email arrives', Boolean(token));

  const agent = new Http();
  const accepted = await agent.call('POST', '/auth/accept-invitation', {
    token,
    name: 'Queue Agent',
    password: 'Sunday-Harbour-Quartz-51',
  });
  check('and can be accepted', accepted.status === 200, `got ${accepted.status}`);

  const agentAttempt = await agent.call('POST', `/visitors/${visitorId}/ban`, {});
  check(
    'an agent cannot ban anybody',
    agentAttempt.status === 403,
    `got ${agentAttempt.status}`,
  );

  const agentLift = await agent.call('DELETE', `/visitors/${visitorId}/ban`);
  check('nor lift a ban', agentLift.status === 403, `got ${agentLift.status}`);

  section('And not on somebody else’s visitor');
  const stranger = await newAccount('bystander', stamp);
  const crossBan = await stranger.client.call('POST', `/visitors/${visitorId}/ban`, {});
  check(
    "another account cannot ban a visitor it does not own",
    crossBan.status === 404,
    `got ${crossBan.status}`,
  );
  const crossLift = await stranger.client.call('DELETE', `/visitors/${visitorId}/ban`);
  check('and cannot lift one either', crossLift.status === 404, `got ${crossLift.status}`);

  const stillFine = await widgetCall('GET', '/widget/me', undefined, visitor.token);
  check(
    'the visitor is unaffected by the stranger trying',
    stillFine.status === 200,
    `got ${stillFine.status}`,
  );

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`${passed} checks passed. A ban survives a reload.\n`);
}

main().catch((error) => {
  process.stdout.write(`\nFATAL: ${error?.stack ?? error}\n`);
  process.exit(1);
});
