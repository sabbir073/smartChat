#!/usr/bin/env node
/**
 * Phase 5: the team, and what "scoped to a website" actually means.
 *
 * The claim this script exists to check is the one an administrator relies on when they tick
 * "limit them to specific websites": that the restricted agent cannot reach the other website's
 * conversations by any route - not in a list, not by guessing an id, not through the API at all.
 *
 *   node scripts/e2e-team.mjs
 *
 * Requires the stack to be up (`docker compose up -d`). The invitation link is read out of the
 * delivered email in Mailpit rather than out of the token table, so a broken template or a
 * silently dropped send fails the test instead of passing it.
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

const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

/**
 * Start a real conversation on one property, the way a visitor does: session, ticket, socket.
 *
 * There is no HTTP endpoint for this on purpose - a visitor only ever talks over the gateway -
 * so the test has to do it the same way rather than through a back door that does not exist.
 */
async function startConversation(publicId, body) {
  const session = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/`, title: 'Team E2E' },
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
    client.once('connect_error', (error) => reject(error));
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
  return started.conversationId;
}

/**
 * Pull the invitation link out of the delivered email.
 *
 * Reading it from Mailpit rather than from the token table is the point: it proves the message was
 * actually built and sent, not merely that a row exists somewhere.
 */
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
      /* Mailpit may not be up yet on the first attempt. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  resetRateLimits();

  const stamp = Date.now();
  const owner = new Http();
  const agentEmail = `agent.${stamp}@example.test`;

  section('Setup');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Team Owner',
    email: `owner.${stamp}@example.test`,
    password: 'Tuesday-Mango-Ferry-42',
    accountName: `Team ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('owner registered', register.status === 201, `got ${register.status}`);

  const siteA = await owner.call('POST', '/properties', {
    name: 'Site A',
    websiteUrl: `https://a-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const siteB = await owner.call('POST', '/properties', {
    name: 'Site B',
    websiteUrl: `https://b-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('two websites created', siteA.status === 201 && siteB.status === 201);
  const propertyA = siteA.body.data;
  const propertyB = siteB.body.data;

  section('Departments');
  const billing = await owner.call('POST', '/team/departments', {
    name: 'Billing',
    key: 'billing',
    isDefault: true,
  });
  check('a department can be created', billing.status === 201, `got ${billing.status}`);

  const sales = await owner.call('POST', '/team/departments', {
    name: 'Sales',
    key: 'sales',
    isDefault: true,
  });
  check('a second department can be created', sales.status === 201, `got ${sales.status}`);

  const departments = await owner.call('GET', '/team/departments');
  const defaults = departments.body.data.filter((entry) => entry.isDefault);
  check(
    'only one department is ever the default',
    defaults.length === 1 && defaults[0].key === 'sales',
    JSON.stringify(departments.body.data.map((d) => `${d.key}:${d.isDefault}`)),
  );

  const duplicateKey = await owner.call('POST', '/team/departments', {
    name: 'Billing again',
    key: 'billing',
  });
  check('a duplicate key is refused', duplicateKey.status === 422, `got ${duplicateKey.status}`);

  section('Roles');
  const role = await owner.call('POST', '/team/roles', {
    name: 'Read-only agent',
    key: 'read_only_agent',
    description: 'Can see conversations, cannot reply.',
    permissions: ['conversation:view_all', 'visitor:view'],
  });
  check('a custom role can be created', role.status === 201, `got ${role.status}`);

  const bogusPermission = await owner.call('POST', '/team/roles', {
    name: 'Nonsense',
    key: 'nonsense',
    permissions: ['conversation:make_coffee'],
  });
  check(
    'an unknown permission is refused rather than stored',
    bogusPermission.status === 422,
    `got ${bogusPermission.status}`,
  );

  section('Invitation');
  const invite = await owner.call('POST', '/team/members', {
    email: agentEmail,
    baseRole: 'agent',
    restrictedToProperties: true,
    propertyIds: [propertyA.id],
    departmentIds: [billing.body.data.id],
  });
  check('the invitation was accepted by the API', invite.status === 201, `got ${invite.status}`);

  const pending = await owner.call('GET', '/team/invitations');
  check(
    'it shows up as pending',
    pending.body.data.invitations.some((entry) => entry.email === agentEmail),
  );

  const duplicate = await owner.call('POST', '/team/members', {
    email: agentEmail,
    baseRole: 'agent',
  });
  check(
    'inviting the same person twice is refused',
    duplicate.status === 409,
    `got ${duplicate.status}`,
  );

  const token = await invitationLinkFor(agentEmail);
  check('the invitation email arrived with a link', typeof token === 'string' && token.length > 20);

  const cannotLoginYet = await new Http().call('POST', '/auth/login', {
    email: agentEmail,
    password: 'Tuesday-Mango-Ferry-42',
  });
  check(
    'an invited address cannot sign in before accepting',
    cannotLoginYet.status === 401,
    `got ${cannotLoginYet.status}`,
  );

  const agent = new Http();
  const accepted = await agent.call('POST', '/auth/accept-invitation', {
    token,
    name: 'Scoped Agent',
    password: 'Wednesday-Lantern-Otter-91',
  });
  check('the invitation can be accepted', accepted.status === 200, `got ${accepted.status}`);
  check('accepting signs them straight in', accepted.body.data?.user?.email === agentEmail);

  const replay = await new Http().call('POST', '/auth/accept-invitation', {
    token,
    name: 'Someone Else',
    password: 'Thursday-Kettle-Badger-77',
  });
  check('the link is single use', replay.status >= 400, `got ${replay.status}`);

  section('Scope is real');
  const visible = await agent.call('GET', '/properties');
  const names = visible.body.data.map((entry) => entry.name);
  check('the scoped agent sees their own website', names.includes('Site A'), names.join(','));
  check('and does not see the other one', !names.includes('Site B'), names.join(','));

  const reachB = await agent.call('GET', `/properties/${propertyB.id}`);
  check(
    'asking for the other website directly returns 404, not 403',
    reachB.status === 404,
    `got ${reachB.status}`,
  );

  const installB = await agent.call('GET', `/properties/${propertyB.id}/install`);
  check(
    'and neither does its installation snippet',
    installB.status === 404,
    `got ${installB.status}`,
  );

  // Real conversations on both websites, started the way a visitor starts one.
  const conversationA = await startConversation(propertyA.publicId, 'Hello from site A');
  const conversationB = await startConversation(propertyB.publicId, 'Hello from site B');
  check('a conversation exists on each website', Boolean(conversationA && conversationB));

  const ownerList = await owner.call('GET', '/conversations?status=open&limit=50');
  const ownerIds = ownerList.body.data.map((entry) => entry.id);
  check(
    'the owner sees conversations from both websites',
    ownerIds.includes(conversationA) && ownerIds.includes(conversationB),
    `${ownerIds.length} conversations`,
  );

  const agentList = await agent.call('GET', '/conversations?status=open&limit=50');
  const agentIds = agentList.body.data.map((entry) => entry.id);
  // An arriving conversation is assigned to nobody. If an agent could not see the unassigned
  // queue, every new chat would be invisible to exactly the people whose job is to answer it.
  check(
    'the scoped agent sees the unassigned queue on their own website',
    agentIds.includes(conversationA),
    agentIds.join(','),
  );
  check(
    'and the other website is simply not there',
    !agentIds.includes(conversationB),
    agentIds.join(','),
  );

  // Searching must narrow what an agent sees, never widen it. Two OR clauses in one query is an
  // easy way to turn "my queue AND matching" into "anyone's queue OR matching".
  const agentSearch = await agent.call('GET', '/conversations?search=Hello&status=open&limit=50');
  const searchIds = agentSearch.body.data.map((entry) => entry.id);
  check(
    'searching finds their own conversation',
    searchIds.includes(conversationA),
    searchIds.join(','),
  );
  check(
    'and a search still cannot reach the other website',
    !searchIds.includes(conversationB),
    searchIds.join(','),
  );

  // Once it belongs to somebody else, it leaves this agent's queue.
  const owningMembers = await owner.call('GET', '/team/members');
  const ownerRow = owningMembers.body.data.members.find((entry) => entry.role === 'owner');
  await owner.call('POST', `/conversations/${conversationA}/assign`, { memberId: ownerRow.id });

  const afterAssign = await agent.call('GET', '/conversations?status=open&limit=50');
  check(
    'a conversation assigned to someone else leaves the agent queue',
    !afterAssign.body.data.map((entry) => entry.id).includes(conversationA),
    afterAssign.body.data.map((entry) => entry.id).join(','),
  );

  await owner.call('POST', `/conversations/${conversationA}/assign`, { memberId: null });

  const reachConversation = await agent.call('GET', `/conversations/${conversationB}`);
  check(
    'a conversation on the other website is 404 by direct id',
    reachConversation.status === 404,
    `got ${reachConversation.status}`,
  );

  const reachMessages = await agent.call('GET', `/conversations/${conversationB}/messages`);
  check('and so are its messages', reachMessages.status === 404, `got ${reachMessages.status}`);

  const replyToB = await agent.call('POST', `/conversations/${conversationB}/messages`, {
    clientMessageId: ulid(),
    body: 'I should not be able to say this.',
    type: 'text',
  });
  check(
    'and it cannot be replied to',
    replyToB.status === 404,
    `got ${replyToB.status}`,
  );

  section('Permission boundaries');
  const agentInvites = await agent.call('POST', '/team/members', {
    email: `nope.${stamp}@example.test`,
    baseRole: 'admin',
  });
  check('an agent cannot invite anybody', agentInvites.status === 403, `got ${agentInvites.status}`);

  const agentReadsTeam = await agent.call('GET', '/team/members');
  check(
    'an agent cannot read the member list',
    agentReadsTeam.status === 403,
    `got ${agentReadsTeam.status}`,
  );

  const ownAvailability = await agent.call('PUT', '/team/availability', { availability: 'away' });
  check(
    'but can always set their own availability',
    ownAvailability.status === 200,
    `got ${ownAvailability.status}`,
  );
  const readBack = await agent.call('GET', '/team/availability');
  check('and read it back', readBack.body.data.availability === 'away');

  section('Owner guards');
  const members = await owner.call('GET', '/team/members');
  const ownerMember = members.body.data.members.find((entry) => entry.role === 'owner');
  const agentMember = members.body.data.members.find((entry) => entry.email === agentEmail);
  check('the member list shows both people', Boolean(ownerMember && agentMember));

  const demoteLastOwner = await owner.call('PATCH', `/team/members/${ownerMember.id}`, {
    baseRole: 'admin',
  });
  check(
    'the last owner cannot be demoted',
    demoteLastOwner.status === 422,
    `got ${demoteLastOwner.status}`,
  );

  const removeSelf = await owner.call('DELETE', `/team/members/${ownerMember.id}`);
  check('and cannot remove themselves', removeSelf.status === 422, `got ${removeSelf.status}`);

  const foreignProperty = await owner.call('PATCH', `/team/members/${agentMember.id}`, {
    restrictedToProperties: true,
    propertyIds: ['00000000-0000-7000-8000-000000000000'],
  });
  check(
    'a website id from outside the account is refused',
    foreignProperty.status === 422,
    `got ${foreignProperty.status}`,
  );

  const stillScoped = await agent.call('GET', '/properties');
  check(
    'and the refused change left the scope exactly as it was',
    stillScoped.body.data.map((entry) => entry.name).join(',') === 'Site A',
    stillScoped.body.data.map((entry) => entry.name).join(','),
  );

  section('Changing the scope takes effect immediately');
  const widen = await owner.call('PATCH', `/team/members/${agentMember.id}`, {
    restrictedToProperties: false,
  });
  check('the restriction can be lifted', widen.status === 200, `got ${widen.status}`);

  const afterWiden = await agent.call('GET', '/properties');
  const widenedNames = afterWiden.body.data.map((entry) => entry.name).sort();
  check(
    'the agent sees both websites on their very next request - no re-login',
    widenedNames.join(',') === 'Site A,Site B',
    widenedNames.join(','),
  );

  const disable = await owner.call('PATCH', `/team/members/${agentMember.id}`, {
    status: 'disabled',
  });
  check('a member can be disabled', disable.status === 200, `got ${disable.status}`);

  const afterDisable = await agent.call('GET', '/properties');
  check(
    'a disabled member loses access immediately, session or not',
    afterDisable.status === 403 || afterDisable.status === 401,
    `got ${afterDisable.status}`,
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
  process.stderr.write(`\nTeam E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
