#!/usr/bin/env node
/**
 * Phase 13: data retention.
 *
 * `Account.dataRetentionDays` had been in the schema since phase 1 and the job that was supposed
 * to honour it logged "nothing to apply yet" for twelve phases. That is the worst kind of
 * unimplemented feature: not a visible gap, but a **promise in the product** quietly unkept. An
 * account that set 90 days believed its customers' transcripts were being deleted. They were not.
 *
 * So this asserts both halves of the promise - what goes, and what stays:
 *
 *   goes:   old conversations, their messages, their attachments, and visitors left with nothing
 *   stays:  recent conversations, tickets, contacts, and the audit log
 *
 * Deleting too much is the more expensive failure of the two, which is why most of these checks
 * are about what survived.
 *
 *   node scripts/e2e-retention.mjs
 *
 * Requires the stack up and the database seeded (the platform administrator comes from the seed).
 */
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const ORIGIN = 'http://localhost:3004';
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL ?? 'admin@smartchat.local';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!SuperAdmin1';
const PGUSER = process.env.POSTGRES_USER ?? 'smartchat';
const PGDB = process.env.POSTGRES_DB ?? 'smartchat';

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

/**
 * Back-dating rows is done with SQL, deliberately.
 *
 * There is no API for "pretend this conversation is a year old", and there should not be - a
 * product that lets a client rewrite when something happened has a much bigger problem than an
 * untestable retention job. The test reaches past the application because the *clock* is the thing
 * being faked, not the data.
 */
function sql(statement) {
  const result = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', PGDB, '-tAc', statement],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`sql failed: ${(result.stderr || '').trim().slice(0, 300)}`);
  }
  return result.stdout.trim();
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

  section('An account with a retention policy, and some history');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Retention Owner',
    email: `retain.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Retention ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('the account was created', register.status === 201, `got ${register.status}`);

  const site = await owner.call('POST', '/properties', {
    name: 'Depot',
    websiteUrl: `https://depot-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const property = site.body.data;

  async function conversation(body) {
    const session = await widgetCall('POST', '/widget/session', {
      p: property.publicId,
      page: { url: `${ORIGIN}/`, title: 'Retention E2E' },
      language: 'en-GB',
      timezone: 'UTC',
    });
    const rt = await widgetCall('POST', '/widget/realtime-ticket', {}, session.body.data.token);
    const socket = await new Promise((resolve, reject) => {
      const client = io(`${REALTIME}/visitor`, {
        transports: ['websocket'],
        auth: { ticket: rt.body.data.ticket },
        reconnection: false,
        timeout: 10000,
      });
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });
    const started = await emit(socket, 'conversation:start', { clientMessageId: ulid(), body });
    socket.close();
    return started.conversationId;
  }

  const old = await conversation('This one is from long ago.');
  const recent = await conversation('This one is from this morning.');
  check('two conversations exist', Boolean(old) && Boolean(recent));

  const ticket = await owner.call('POST', '/tickets', {
    propertyId: property.id,
    subject: 'A commercial record',
    body: 'What was asked for, and what was promised.',
    requesterEmail: `keep.${stamp}@example.test`,
    notifyRequester: false,
  });
  check('and a ticket', ticket.status === 201, `got ${ticket.status}`);

  const accountId = sql(
    `SELECT id FROM accounts WHERE name = 'Retention ${stamp}' LIMIT 1`,
  );
  check('the account is findable', accountId.length === 36, accountId);

  section('A policy is set, and one conversation is made old');
  const policy = await owner.call('PATCH', '/account', { dataRetentionDays: 30 });
  check('a retention policy can be set', policy.status === 200, JSON.stringify(policy.body?.error));
  check(
    'and is stored',
    policy.body.data.account.dataRetentionDays === 30,
    JSON.stringify(policy.body.data),
  );

  const tooShort = await owner.call('PATCH', '/account', { dataRetentionDays: 1 });
  check(
    'a policy shorter than a week is refused - that is a foot-gun, not a setting',
    tooShort.status === 422,
    `got ${tooShort.status}`,
  );

  // 400 days old: comfortably outside a 30-day window, and outside any window an account can set.
  sql(
    `UPDATE conversations SET last_message_at = now() - interval '400 days',
     started_at = now() - interval '400 days' WHERE id = '${old}'`,
  );
  const messagesBefore = Number(
    sql(`SELECT count(*) FROM messages WHERE conversation_id = '${old}'`),
  );
  check('the old conversation still has its messages', messagesBefore > 0, `${messagesBefore}`);

  section('Apply retention');
  const console_ = new Http();
  const signedIn = await console_.call('POST', '/platform/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  check('an operator can sign in', signedIn.status === 200, `got ${signedIn.status}`);

  const applied = await console_.call('POST', '/platform/maintenance/retention');
  check('retention can be applied on demand', applied.status === 200, JSON.stringify(applied.body?.error));
  check(
    'and it reports what it did',
    typeof applied.body.data.conversationsDeleted === 'number' &&
      applied.body.data.conversationsDeleted >= 1,
    JSON.stringify(applied.body.data),
  );

  section('What went');
  check(
    'the old conversation is gone',
    sql(`SELECT count(*) FROM conversations WHERE id = '${old}'`) === '0',
  );
  check(
    'and its messages went with it, rather than being orphaned',
    sql(`SELECT count(*) FROM messages WHERE conversation_id = '${old}'`) === '0',
  );

  section('What stayed - the half that matters more');
  check(
    'the recent conversation is untouched',
    sql(`SELECT count(*) FROM conversations WHERE id = '${recent}'`) === '1',
  );
  check(
    'its messages are untouched',
    Number(sql(`SELECT count(*) FROM messages WHERE conversation_id = '${recent}'`)) > 0,
  );
  check(
    'the ticket survived - a commercial record is not a chat transcript',
    sql(`SELECT count(*) FROM tickets WHERE id = '${ticket.body.data.id}'`) === '1',
  );
  check(
    'the audit log survived - a policy that erased the record of its own operation would be self-defeating',
    Number(sql(`SELECT count(*) FROM audit_logs WHERE account_id = '${accountId}'`)) > 0,
  );
  check(
    'and every other account is untouched',
    Number(sql(`SELECT count(*) FROM conversations WHERE account_id <> '${accountId}'`)) > 0,
  );

  const stillWorks = await owner.call('GET', '/conversations');
  check(
    'the account still works normally afterwards',
    stillWorks.status === 200,
    `got ${stillWorks.status}`,
  );

  section('An account with no policy keeps everything');
  const keeper = new Http();
  await keeper.call('POST', '/auth/register', {
    name: 'Keeper Owner',
    email: `keeper.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Keeper ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  const keeperSite = await keeper.call('POST', '/properties', {
    name: 'Vault',
    websiteUrl: `https://vault-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const keeperAccount = sql(`SELECT id FROM accounts WHERE name = 'Keeper ${stamp}' LIMIT 1`);
  const keeperTicket = await keeper.call('POST', '/tickets', {
    propertyId: keeperSite.body.data.id,
    subject: 'Ancient but kept',
    body: 'No policy means keep forever.',
    requesterEmail: `vault.${stamp}@example.test`,
    notifyRequester: false,
  });
  check('a second account exists with no policy', keeperTicket.status === 201);
  check(
    'and its retention is genuinely null, not a hidden default',
    sql(`SELECT coalesce(data_retention_days::text, 'null') FROM accounts WHERE id = '${keeperAccount}'`) ===
      'null',
  );

  const secondRun = await console_.call('POST', '/platform/maintenance/retention');
  check('retention runs again cleanly', secondRun.status === 200);
  check(
    'and it is idempotent - the second run finds nothing left to delete for that account',
    secondRun.body.data.conversationsDeleted === 0,
    JSON.stringify(secondRun.body.data),
  );
  check(
    "the account with no policy still has everything",
    sql(`SELECT count(*) FROM tickets WHERE account_id = '${keeperAccount}'`) === '1',
  );

  section('It is recorded');
  const audit = await console_.call('GET', '/platform/audit?limit=20');
  check('the platform audit log is readable', audit.status === 200);

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
  process.stderr.write(`\nRetention E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
